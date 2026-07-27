/**
 * Pokecheck standalone engine - a client-side port of index.php's PvP
 * calculator, evolution-family resolver, and ranking/attacker CSV lookups.
 *
 * This exists so the Android app (packaged with Capacitor, no PHP runtime
 * available on-device) can answer the exact same searches the PHP-backed
 * web app does, from the exact same data.json + /rankings CSVs, with no
 * server and no network access at all. Every function here is a direct,
 * behavior-preserving port of its index.php counterpart - see that file's
 * comments for the "why" behind each algorithm; this file only repeats
 * comments where the JS/PHP mapping isn't 1:1.
 */
(function (global) {
  'use strict';

  var gameData = null;
  var rankingCsvCache = {};
  var attackerDpsCache = {};
  var attackerTierCache = {};
  var canonicalIndex = null;

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------

  function fetchText(path) {
    return fetch(path).then(function (res) {
      if (!res.ok) {
        throw new Error('Failed to load ' + path + ' (' + res.status + ')');
      }
      return res.text();
    });
  }

  function fetchJson(path) {
    return fetch(path).then(function (res) {
      if (!res.ok) {
        throw new Error('Failed to load ' + path + ' (' + res.status + ')');
      }
      return res.json();
    });
  }

  /**
   * Splits raw CSV text into rows of raw string cells. None of this app's
   * shipped CSVs quote any field (verified: zero '"' characters across all
   * of them), so a plain comma/newline split is safe and avoids needing a
   * full RFC 4180 parser.
   */
  function parseCsv(text) {
    var lines = text.replace(/\r\n/g, '\n').split('\n');
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') {
        continue;
      }
      rows.push(line.split(','));
    }
    return rows;
  }

  function csvToObjects(text) {
    var rows = parseCsv(text);
    if (rows.length === 0) {
      return { header: [], records: [] };
    }
    var header = rows[0];
    var records = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var record = {};
      for (var c = 0; c < header.length; c++) {
        record[header[c]] = row[c] !== undefined ? row[c] : '';
      }
      records.push(record);
    }
    return { header: header, records: records };
  }

  // ---------------------------------------------------------------------
  // Input handling (mirrors normalize_species_slug)
  // ---------------------------------------------------------------------

  function normalizeSpeciesSlug(raw) {
    var trimmed = String(raw).trim();

    if (trimmed === '' || trimmed.length > 60) {
      return null;
    }

    var lower = trimmed.toLowerCase();
    lower = lower.replace(/♀/g, ' female').replace(/♂/g, ' male');
    var slug = lower.replace(/'/g, '').replace(/\./g, '');
    slug = slug.replace(/[^a-z0-9]+/g, '_');
    slug = slug.replace(/^_+|_+$/g, '');

    return slug === '' ? null : slug;
  }

  // ---------------------------------------------------------------------
  // Species artwork
  // ---------------------------------------------------------------------

  // The web app checks is_file() server-side; on-device we simply always
  // point at the expected path (the image pipeline covers every baseStats
  // key - see images/README.md - with a small documented fallback list),
  // and let the <img> tag itself fail silently if a file is ever missing.
  function resolveImagePath(slug, variant) {
    return 'images/' + variant + '/' + slug + '.webp';
  }

  // ---------------------------------------------------------------------
  // Evolution family resolution
  // ---------------------------------------------------------------------

  function resolveSpeciesKey(slug) {
    if (gameData.baseStats[slug]) {
      return slug;
    }
    var alias = gameData.displayNameAliases[slug];
    return alias && gameData.baseStats[alias] ? alias : null;
  }

  function resolveEvolutionFamily(speciesKey, baseStats) {
    var family = baseStats[speciesKey] && baseStats[speciesKey].family ? baseStats[speciesKey].family : null;

    if (!family) {
      return {
        names: [speciesKey],
        canEvolveFurther: (function () { var o = {}; o[speciesKey] = false; return o; })(),
        stage: (function () { var o = {}; o[speciesKey] = 0; return o; })(),
      };
    }

    var familyId = family.id;
    var members = {};
    Object.keys(baseStats).forEach(function (key) {
      var entry = baseStats[key];
      if (entry.family && entry.family.id === familyId) {
        members[key] = entry.family;
      }
    });

    var roots = [];
    Object.keys(members).forEach(function (key) {
      if (!members[key].parent) {
        roots.push(key);
      }
    });

    if (roots.length === 0) {
      roots = [speciesKey];
    }

    var orderedNames = [];
    var canEvolveFurther = {};
    var stage = {};
    var queue = roots.map(function (root) { return [root, 0]; });

    while (queue.length > 0) {
      var pair = queue.shift();
      var current = pair[0];
      var depth = pair[1];

      if (!members[current] || orderedNames.indexOf(current) !== -1) {
        continue;
      }

      orderedNames.push(current);
      stage[current] = depth;
      var evolutions = members[current].evolutions || [];
      canEvolveFurther[current] = evolutions.length > 0;

      evolutions.forEach(function (next) {
        queue.push([next, depth + 1]);
      });
    }

    return { names: orderedNames, canEvolveFurther: canEvolveFurther, stage: stage };
  }

  // ---------------------------------------------------------------------
  // PvP IV calculator
  // ---------------------------------------------------------------------

  function calculateCp(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpm) {
    var atk = baseAtk + ivAtk;
    var def = baseDef + ivDef;
    var sta = baseSta + ivSta;
    return Math.floor(atk * Math.sqrt(def) * Math.sqrt(sta) * cpm * cpm / 10);
  }

  function findMaxLevelIndexUnderCap(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpCap, cpms) {
    var lastValidIndex = -1;
    var low = 0;
    var high = cpms.length - 1;

    while (low <= high) {
      var mid = Math.floor((low + high) / 2);
      var cp = calculateCp(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpms[mid]);

      if (cp <= cpCap) {
        lastValidIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return lastValidIndex;
  }

  function findOptimalPvpBuild(baseAtk, baseDef, baseSta, cpCap, levelLabels, cpms) {
    var best = null;

    for (var ivAtk = 0; ivAtk <= 15; ivAtk++) {
      for (var ivDef = 0; ivDef <= 15; ivDef++) {
        for (var ivSta = 0; ivSta <= 15; ivSta++) {
          var levelIndex = findMaxLevelIndexUnderCap(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpCap, cpms);

          if (levelIndex === -1) {
            continue;
          }

          var cpm = cpms[levelIndex];
          var statAtk = (baseAtk + ivAtk) * cpm;
          var statDef = (baseDef + ivDef) * cpm;
          var statHp = Math.floor((baseSta + ivSta) * cpm);
          var statProduct = statAtk * statDef * statHp;

          if (best === null || statProduct > best.statProduct) {
            best = {
              ivAtk: ivAtk,
              ivDef: ivDef,
              ivSta: ivSta,
              level: levelLabels[levelIndex],
              cp: calculateCp(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpm),
              statProduct: Math.round(statProduct),
            };
          }
        }
      }
    }

    return best;
  }

  function buildMasterLeagueEntry(baseAtk, baseDef, baseSta, cpMultipliers) {
    var topLevel = '51.0';
    var cpm = cpMultipliers[topLevel];

    var statAtk = (baseAtk + 15) * cpm;
    var statDef = (baseDef + 15) * cpm;
    var statHp = Math.floor((baseSta + 15) * cpm);

    return {
      eligible: true,
      ivAtk: 15,
      ivDef: 15,
      ivSta: 15,
      level: topLevel,
      cp: calculateCp(baseAtk, 15, baseDef, 15, baseSta, 15, cpm),
      statProduct: Math.round(statAtk * statDef * statHp),
    };
  }

  function computeAllLeagues(memberSlug, baseAtk, baseDef, baseSta, leagues, cpMultipliers) {
    var levelLabels = Object.keys(cpMultipliers);
    var cpms = levelLabels.map(function (l) { return cpMultipliers[l]; });

    var result = {};

    Object.keys(leagues).forEach(function (leagueId) {
      var league = leagues[leagueId];
      var entry;

      if (league.cpCap === null) {
        entry = buildMasterLeagueEntry(baseAtk, baseDef, baseSta, cpMultipliers);
      } else {
        var build = findOptimalPvpBuild(baseAtk, baseDef, baseSta, league.cpCap, levelLabels, cpms);

        entry = build === null
          ? {
            eligible: false,
            reason: 'Base stats are too high to fit under the ' + league.cpCap + ' CP cap even at 0/0/0, level 1.',
          }
          : Object.assign({ eligible: true }, build);
      }

      entry.ranking = lookupLeagueRanking(memberSlug, league);
      entry.shadowRanking = lookupLeagueRanking(memberSlug + '_shadow', league);

      result[leagueId] = entry;
    });

    return result;
  }

  // ---------------------------------------------------------------------
  // Community PvP ranking lookup (PvPoke-style CSV exports)
  // ---------------------------------------------------------------------

  var RANKING_REGION_TAGS = { alolan: true, galarian: true, hisuian: true, paldean: true };
  var RANKING_DISCARD_TOKENS = { standard: true };

  function tokenizeRankingName(name) {
    var lower = String(name).toLowerCase();
    lower = lower.replace(/♀/g, ' female').replace(/♂/g, ' male');
    var clean = lower.replace(/['.()\-]/g, ' ');
    clean = clean.replace(/[^a-z0-9]+/g, ' ');
    return clean.trim().split(' ').filter(function (t) { return t !== ''; });
  }

  function canonicalizeSpeciesTokens(tokens) {
    var base = [];
    var tags = [];

    tokens.forEach(function (t) {
      t = String(t).toLowerCase();
      if (t === '' || RANKING_DISCARD_TOKENS[t]) {
        return;
      }
      if (RANKING_REGION_TAGS[t]) {
        tags.push(t);
      } else {
        base.push(t);
      }
    });

    tags.sort();

    return base.join('_') + '|' + tags.join(',');
  }

  function getCanonicalSpeciesIndex() {
    if (canonicalIndex !== null) {
      return canonicalIndex;
    }

    canonicalIndex = {};
    Object.keys(gameData.baseStats).forEach(function (key) {
      var canonical = canonicalizeSpeciesTokens(key.split('_'));
      if (!canonicalIndex[canonical]) {
        canonicalIndex[canonical] = key;
      }
    });

    return canonicalIndex;
  }

  /**
   * PHP's isset($row[...]) is true for a present-but-empty CSV cell (only
   * an entirely missing column is null) and (float)/(int) casts an empty
   * string to 0 rather than NaN - so these mirror PHP's cast behavior
   * exactly rather than JS's default truthiness/NaN handling, which would
   * otherwise turn a genuinely-empty cell into null instead of 0/''.
   */
  function toFloatOrZero(v) {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function toIntOrZero(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }

  function cleanMoveName(rawMoveName) {
    var decoded = String(rawMoveName)
      .replace(/&dagger;/g, '†')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    var stripped = decoded.replace(/<[^>]*>/g, '');
    return stripped.trim();
  }

  function normalizeRankingPokemonName(name) {
    var tokens = tokenizeRankingName(name);
    var isShadow = false;
    var remaining = [];

    tokens.forEach(function (t) {
      if (t === 'shadow') {
        isShadow = true;
      } else {
        remaining.push(t);
      }
    });

    var canonical = canonicalizeSpeciesTokens(remaining);
    var index = getCanonicalSpeciesIndex();
    var slug = index[canonical] || remaining.join('_');

    return isShadow && slug !== '' ? slug + '_shadow' : slug;
  }

  function loadRankingCsv(relativePath) {
    if (rankingCsvCache[relativePath]) {
      return rankingCsvCache[relativePath];
    }

    var parsed = csvCache[relativePath];
    var bySlug = {};
    var ordered = [];
    var rank = 0;

    if (parsed) {
      parsed.records.forEach(function (row) {
        var name = row['Pokemon'];
        if (!name) {
          return;
        }

        rank++;
        var slug = normalizeRankingPokemonName(name);

        var entry = {
          rank: rank,
          name: name,
          slug: slug,
          score: row['Score'] !== undefined ? toFloatOrZero(row['Score']) : null,
          statProduct: row['Stat Product'] !== undefined ? toIntOrZero(row['Stat Product']) : null,
          level: row['Level'] !== undefined ? row['Level'] : null,
          cp: row['CP'] !== undefined ? toIntOrZero(row['CP']) : null,
          fastMove: row['Fast Move'] !== undefined ? cleanMoveName(row['Fast Move']) : null,
          chargedMove1: row['Charged Move 1'] !== undefined ? cleanMoveName(row['Charged Move 1']) : null,
          chargedMove2: row['Charged Move 2'] !== undefined ? cleanMoveName(row['Charged Move 2']) : null,
        };

        // The full leaderboard (leaderboard() below) wants every row in
        // original rank order, unlike bySlug which keeps only each slug's
        // best-ranked occurrence for direct lookups.
        ordered.push(entry);

        if (!bySlug[slug]) {
          bySlug[slug] = entry;
        }
      });
    }

    var result = { bySlug: bySlug, ordered: ordered, totalRanked: rank };
    rankingCsvCache[relativePath] = result;
    return result;
  }

  function lookupLeagueRanking(memberSlug, league) {
    if (!league.rankingFile) {
      return null;
    }

    var csv = loadRankingCsv(league.rankingFile);
    var entry = csv.bySlug[memberSlug];

    if (!entry) {
      return null;
    }

    return Object.assign({}, entry, { totalRanked: csv.totalRanked });
  }

  /**
   * Mirrors index.php's get_league_leaderboard(): the full rank-ordered
   * list for one league (the "Browse Rankings" view), each row's CSV-
   * derived slug cross-checked against baseStats/displayNameAliases so
   * the front end knows which rows are tappable (jump to that species'
   * card) versus informational-only (e.g. most Mega entries in the 500
   * CP file, which this app doesn't track as species).
   */
  function getLeagueLeaderboard(league) {
    if (!league.rankingFile) {
      return null;
    }

    var csv = loadRankingCsv(league.rankingFile);

    var rows = csv.ordered.map(function (entry) {
      var copy = Object.assign({}, entry);
      var isShadow = copy.slug.indexOf('_shadow', copy.slug.length - '_shadow'.length) !== -1;
      var baseSlug = isShadow ? copy.slug.slice(0, -'_shadow'.length) : copy.slug;

      copy.isShadow = isShadow;
      copy.resolvedSlug = resolveSpeciesKey(baseSlug);
      delete copy.slug;
      return copy;
    });

    return { rows: rows, totalRanked: csv.totalRanked };
  }

  // ---------------------------------------------------------------------
  // Raid attacker DPS / type-attacker / tier-list lookup
  // ---------------------------------------------------------------------

  function loadAttackerDpsCsv(relativePath) {
    if (attackerDpsCache[relativePath]) {
      return attackerDpsCache[relativePath];
    }

    var parsed = csvCache[relativePath];
    var rows = [];
    var bySlug = {};

    if (parsed) {
      parsed.records.forEach(function (row) {
        var name = row['Pokemon'];
        if (!name) {
          return;
        }

        var slug = normalizeRankingPokemonName(name);
        var rowIndex = rows.length;

        rows.push({
          rank: rowIndex + 1,
          name: name,
          type1: row['Type1'] !== undefined ? row['Type1'].toLowerCase() : '',
          type2: row['Type2'] !== undefined ? row['Type2'].toLowerCase() : '',
          fastMove: row['Fast Move'] !== undefined ? cleanMoveName(row['Fast Move']) : null,
          chargedMove: row['Charged Move'] !== undefined ? cleanMoveName(row['Charged Move']) : null,
          dps: row['DPS'] !== undefined ? toFloatOrZero(row['DPS']) : null,
          tdo: row['TDO'] !== undefined ? toIntOrZero(row['TDO']) : null,
          er: row['ER'] !== undefined ? toFloatOrZero(row['ER']) : null,
          cp: row['CP'] !== undefined ? toIntOrZero(row['CP']) : null,
          isShadow: (row['Shadow'] || '').toLowerCase() === 'true',
          isMega: (row['Mega'] || '').toLowerCase() === 'true',
        });

        if (bySlug[slug] === undefined) {
          bySlug[slug] = rowIndex;
        }
      });
    }

    var result = { rows: rows, bySlug: bySlug };
    attackerDpsCache[relativePath] = result;
    return result;
  }

  function loadAttackerTierCsv(relativePath) {
    if (attackerTierCache[relativePath]) {
      return attackerTierCache[relativePath];
    }

    var parsed = csvCache[relativePath];
    var bySlug = {};
    var rank = 0;

    if (parsed) {
      parsed.records.forEach(function (row) {
        var name = row['Pokemon'];
        if (!name) {
          return;
        }

        rank++;
        var slug = normalizeRankingPokemonName(name);

        if (!bySlug[slug]) {
          bySlug[slug] = { tier: row['Tier'] || '', rank: rank };
        }
      });
    }

    attackerTierCache[relativePath] = bySlug;
    return bySlug;
  }

  function buildAttackerSummary(memberSlug, types, attackerRankings) {
    var dps = loadAttackerDpsCsv(attackerRankings.dpsFile);
    var rowIndex = dps.bySlug[memberSlug];

    if (rowIndex === undefined) {
      return null;
    }

    var row = dps.rows[rowIndex];

    var byType = {};
    types.forEach(function (type) {
      type = type.toLowerCase();
      var matching = dps.rows.filter(function (r) { return r.type1 === type || r.type2 === type; });

      var positionInType = null;
      for (var i = 0; i < matching.length; i++) {
        if (matching[i].name === row.name) {
          positionInType = i + 1;
          break;
        }
      }

      byType[type] = {
        rank: positionInType,
        total: matching.length,
        isTop10: positionInType !== null && positionInType <= 10,
      };
    });

    var tierData = loadAttackerTierCsv(attackerRankings.tierFile);
    var tier = tierData[memberSlug] || null;

    return {
      name: row.name,
      overallRank: row.rank,
      totalOverall: dps.rows.length,
      dps: row.dps,
      tdo: row.tdo,
      er: row.er,
      cp: row.cp,
      fastMove: row.fastMove,
      chargedMove: row.chargedMove,
      isShadow: row.isShadow,
      isMega: row.isMega,
      byType: byType,
      tier: tier === null ? null : { label: tier.tier, rank: tier.rank },
    };
  }

  // ---------------------------------------------------------------------
  // Search / species-list (mirrors handle_search_request_body /
  // handle_species_list_request's exact response shape)
  // ---------------------------------------------------------------------

  var csvCache = {};

  function search(rawQuery) {
    var slug = normalizeSpeciesSlug(rawQuery);

    if (slug === null) {
      return { success: false, error: 'Please enter a Pokemon name to search.' };
    }

    var baseStats = gameData.baseStats;
    var speciesKey = resolveSpeciesKey(slug);

    if (speciesKey === null) {
      return {
        success: false,
        error: 'Couldn\'t find a Pokemon named "' + rawQuery + '". Check the spelling and try again.',
      };
    }

    var family = resolveEvolutionFamily(speciesKey, baseStats);
    var leagues = gameData.leagues;
    var cpMultipliers = gameData.cpMultipliers;
    var attackerRankings = gameData.attackerRankings;
    var shadowEligibleSpecies = {};
    gameData.shadowEligibleSpecies.forEach(function (s) { shadowEligibleSpecies[s] = true; });

    var members = family.names.map(function (memberSlug) {
      var stats = baseStats[memberSlug];
      var isShadowEligible = !!shadowEligibleSpecies[memberSlug];

      return {
        slug: memberSlug,
        dex: stats.dex,
        displayName: stats.displayName,
        types: stats.types,
        heroImage: resolveImagePath(memberSlug, 'hero'),
        iconImage: resolveImagePath(memberSlug, 'icon'),
        baseStats: {
          attack: stats.attack,
          defense: stats.defense,
          stamina: stats.stamina,
        },
        attacker: buildAttackerSummary(memberSlug, stats.types, attackerRankings),
        littleCupEligible: family.canEvolveFurther[memberSlug] || false,
        evolutionStage: family.stage[memberSlug] || 0,
        leagues: computeAllLeagues(memberSlug, stats.attack, stats.defense, stats.stamina, leagues, cpMultipliers),
        shadowEligible: isShadowEligible,
        shadowAttacker: isShadowEligible
          ? buildAttackerSummary(memberSlug + '_shadow', stats.types, attackerRankings)
          : null,
      };
    });

    return {
      success: true,
      query: rawQuery,
      resolvedSlug: speciesKey,
      leagueDefinitions: leagues,
      family: members,
    };
  }

  function speciesList() {
    var baseStats = gameData.baseStats;
    var byDex = {};

    Object.keys(baseStats).forEach(function (slug) {
      var dex = baseStats[slug].dex;
      if (!byDex[dex]) {
        byDex[dex] = [];
      }
      byDex[dex].push(slug);
    });

    var list = Object.keys(baseStats).map(function (slug) {
      var entry = baseStats[slug];
      var label = entry.displayName;
      var isAmbiguous = byDex[entry.dex].length > 1;

      if (isAmbiguous && label.indexOf('(') === -1) {
        label += ' (Normal)';
      }

      return {
        slug: slug,
        label: label,
        dex: entry.dex,
        types: entry.types,
        iconImage: resolveImagePath(slug, 'icon'),
      };
    });

    list.sort(function (a, b) {
      return a.dex - b.dex || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    });

    return { success: true, species: list };
  }

  function moves() {
    return { success: true, moves: gameData.moves };
  }

  function cpMultipliers() {
    return { success: true, cpMultipliers: gameData.cpMultipliers };
  }

  function typeChart() {
    return { success: true, typeEffectiveness: gameData.typeEffectiveness };
  }

  function leaderboard(leagueId) {
    var league = gameData.leagues[leagueId];

    if (!league) {
      return { success: false, error: 'Unknown league.' };
    }

    var result = getLeagueLeaderboard(league);

    if (!result) {
      return { success: false, error: 'This league has no ranking data.' };
    }

    return { success: true, league: leagueId, rows: result.rows, totalRanked: result.totalRanked };
  }

  // ---------------------------------------------------------------------
  // Init / public API
  // ---------------------------------------------------------------------

  var readyPromise = null;

  function init() {
    if (readyPromise) {
      return readyPromise;
    }

    var csvFiles = [
      'rankings/custom_cp500_all_custom_rankings.csv',
      'rankings/cp1500_all_overall_rankings.csv',
      'rankings/cp1500_summer_overall_rankings.csv',
      'rankings/cp2500_all_overall_rankings.csv',
      'rankings/cp10000_all_overall_rankings.csv',
      'rankings/attacker_dps_rankings.csv',
      'rankings/attacker_tier_list.csv',
    ];

    readyPromise = fetchJson('data.json')
      .then(function (data) {
        gameData = data;
        return Promise.all(csvFiles.map(function (path) {
          return fetchText(path).then(function (text) {
            csvCache[path] = csvToObjects(text);
          });
        }));
      });

    return readyPromise;
  }

  global.PvPEngine = {
    init: init,
    search: search,
    speciesList: speciesList,
    moves: moves,
    cpMultipliers: cpMultipliers,
    typeChart: typeChart,
    leaderboard: leaderboard,
  };
})(window);
