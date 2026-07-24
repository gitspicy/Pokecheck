/**
 * Pokecheck front-end controller.
 *
 * Sends the user's search term to index.php (?action=search) via jQuery
 * AJAX and renders the JSON response into family cards, without ever
 * reloading the page.
 */
(function ($) {
  'use strict';

  var $input = $('#pokemon-input');
  var $searchBtn = $('#search-btn');
  var $statusArea = $('#status-area');
  var $results = $('#results');

  var LEAGUE_ORDER = ['greatLeague', 'ultraLeague', 'masterLeague', 'littleCup', 'summerLeague'];

  // Worst-to-best order, used both to pick a heatmap CSS class (gray -> red
  // -> green) and to decide which "S and above" tiers earn a medal emoji.
  var TIER_ORDER = ['F', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS', 'SSSS', 'SSSSS'];
  var TIER_MEDALS = { SS: '🥉', SSS: '🥈', SSSS: '🥇', SSSSS: '🏆' };

  var RECENT_SEARCHES_KEY = 'pokecheck.recentSearches';
  var MAX_RECENT_SEARCHES = 20;
  var $recentPicks = $('#recent-picks');

  var $autocompleteList = $('#autocomplete-list');
  var MAX_AUTOCOMPLETE_RESULTS = 20;
  var allSpecies = []; // [{slug, label, dex, types, searchKey}], fetched once on load
  var autocompleteHighlightIndex = -1;

  // Move-detail tooltips: {normalizedName: {name, type, power, energyGain,
  // energyCost, turns, buffs?, buffTarget?, buffChance?}}, fetched once on
  // load (see loadMovesTable()) and consulted by moveChip() below.
  var movesByKey = {};
  var $moveTooltip = $('<div class="move-tooltip-popover" hidden></div>').appendTo('body');
  var activeMoveChipEl = null;

  /**
   * Escapes text before it is dropped into an HTML template string, so
   * nothing derived from user input (e.g. the echoed search query) can
   * inject markup.
   */
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setStatus(html, className) {
    if (!html) {
      $statusArea.empty();
      return;
    }
    $statusArea.html('<div class="message' + (className ? ' ' + className : '') + '">' + html + '</div>');
  }

  function setLoading(isLoading) {
    $searchBtn.prop('disabled', isLoading);
    $searchBtn.text(isLoading ? 'Searching...' : 'Search');
  }

  function formatIvSet(entry) {
    return entry.ivAtk + ' / ' + entry.ivDef + ' / ' + entry.ivSta;
  }

  /**
   * Renders a community-tier letter (F through SSSSS) as a heatmap badge -
   * gray at the bottom, red-to-green climbing through the middle tiers,
   * with SS/SSS/SSSS/SSSSS (the "S and above" tiers) each additionally
   * earning a medal emoji so they stand out even at a glance.
   */
  function renderTierBadge(tierLabel, extraClass) {
    var index = TIER_ORDER.indexOf(tierLabel);
    var cssIndex = index === -1 ? 0 : index;
    var medal = TIER_MEDALS[tierLabel] ? ' ' + TIER_MEDALS[tierLabel] : '';

    return (
      '<span class="badge tier-heat tier-heat-' + cssIndex + (extraClass ? ' ' + extraClass : '') + '">' +
        'Tier ' + escapeHtml(tierLabel) + medal +
      '</span>'
    );
  }

  /**
   * Shared rank-highlight/star system used by every "#N of M" figure in the
   * app (PvP league rank, raid-attacker overall rank, type-attacker rank,
   * community tier rank): top 50 gets a highlighted pill, and additionally
   * top 25 / top 10 / top 5 add 1 / 2 / 3 stars on top of that highlight.
   */
  function rankBadge(rank, total) {
    if (!rank) {
      return '<span class="unranked">Unranked</span>';
    }

    var highlightClass = rank <= 50 ? ' rank-highlight' : '';
    var stars = '';
    if (rank <= 5) {
      stars = '⭐⭐⭐';
    } else if (rank <= 10) {
      stars = '⭐⭐';
    } else if (rank <= 25) {
      stars = '⭐';
    }
    var starsHtml = stars ? ' <span class="rank-stars">' + stars + '</span>' : '';
    var totalHtml = total ? ' <span class="rank-total">of ' + total + '</span>' : '';

    return '<span class="rank-value' + highlightClass + '">#' + rank + totalHtml + '</span>' + starsHtml;
  }

  function formatRank(ranking) {
    if (!ranking) {
      return '<span class="unranked">Unranked<br><small>not in dataset</small></span>';
    }
    return (
      rankBadge(ranking.rank, ranking.totalRanked) +
      '<br><small>Score ' + ranking.score + '</small>'
    );
  }

  /**
   * Wraps a move name in a tappable "chip" that opens a stats tooltip
   * (type/power/energy/buff - see formatMoveTooltip()) if that move is in
   * movesByKey, otherwise falls back to plain escaped text. The name is
   * looked up via toSearchKey() - the same lowercase-alnum-only reduction
   * used to build data.json's "moves" table - which conveniently also
   * strips the trailing "*"/"&dagger;" legacy/Elite-TM marker some move
   * names carry, without needing a separate regex for it.
   */
  function moveChip(name) {
    if (!name) {
      return '';
    }

    var key = toSearchKey(name);
    var info = movesByKey[key];

    if (!info) {
      return escapeHtml(name);
    }

    return (
      '<button type="button" class="move-chip" data-move-key="' + escapeHtml(key) + '">' +
        escapeHtml(name) +
      '</button>'
    );
  }

  function formatMoveset(ranking) {
    if (!ranking) {
      return '<span class="unranked">&mdash;</span>';
    }
    return (
      moveChip(ranking.fastMove) +
      '<br><small>' + moveChip(ranking.chargedMove1) + ' + ' + moveChip(ranking.chargedMove2) + '</small>'
    );
  }

  /**
   * Builds a move-detail tooltip's inner HTML: type/power always, then
   * either Energy Gain + Turns (fast moves, energyGain > 0) or Energy Cost
   * (charged moves), plus a buff line when the move has a chance to raise/
   * lower a stat stage (e.g. Ancient Power's self-buff, Superpower's
   * self-debuff) - the exact mechanic PvP players care about a charged
   * move for beyond raw power.
   */
  function formatMoveTooltip(info) {
    var typeBadge = '<span class="type-badge type-' + escapeHtml(info.type) + '">' + escapeHtml(info.type) + '</span>';
    var isFastMove = info.energyGain > 0;

    var rows =
      '<div class="move-tooltip-row"><span>Type</span>' + typeBadge + '</div>' +
      '<div class="move-tooltip-row"><span>Power</span><strong>' + info.power + '</strong></div>';

    rows += isFastMove
      ? '<div class="move-tooltip-row"><span>Energy Gain</span><strong>+' + info.energyGain + '</strong></div>' +
        '<div class="move-tooltip-row"><span>Turns</span><strong>' + info.turns + '</strong></div>'
      : '<div class="move-tooltip-row"><span>Energy Cost</span><strong>' + info.energyCost + '</strong></div>';

    if (info.buffs && (info.buffs[0] !== 0 || info.buffs[1] !== 0)) {
      var statParts = [];
      if (info.buffs[0] !== 0) { statParts.push((info.buffs[0] > 0 ? '+' : '') + info.buffs[0] + ' Attack'); }
      if (info.buffs[1] !== 0) { statParts.push((info.buffs[1] > 0 ? '+' : '') + info.buffs[1] + ' Defense'); }
      var target = info.buffTarget === 'opponent' ? "opponent's" : 'own';
      var chancePct = Math.round((info.buffChance || 0) * 100);

      rows += (
        '<div class="move-tooltip-row move-tooltip-buff">' +
          '<span>' + chancePct + '% chance</span>' +
          '<strong>' + escapeHtml(statParts.join(', ')) + ' (' + target + ')</strong>' +
        '</div>'
      );
    }

    return '<div class="move-tooltip-title">' + escapeHtml(info.name) + '</div>' + rows;
  }

  function closeMoveTooltip() {
    $moveTooltip.attr('hidden', true).empty();
    if (activeMoveChipEl) {
      $(activeMoveChipEl).removeClass('active');
    }
    activeMoveChipEl = null;
  }

  /**
   * Positions the shared tooltip element next to the tapped chip using
   * viewport-relative coordinates (position: fixed in CSS) rather than
   * relying on an ancestor's position:relative - the league table scrolls
   * horizontally (.table-scroll), and a plain absolutely-positioned
   * tooltip would either get clipped by that scroll container or drift
   * out of sync with the chip. Clamped so it never overflows the viewport.
   */
  function openMoveTooltip(chipEl, info) {
    $moveTooltip.html(formatMoveTooltip(info)).removeAttr('hidden');

    var chipRect = chipEl.getBoundingClientRect();
    var tooltipRect = $moveTooltip.get(0).getBoundingClientRect();

    var left = Math.max(8, Math.min(chipRect.left, window.innerWidth - tooltipRect.width - 8));
    var top = chipRect.bottom + 6;
    if (top + tooltipRect.height > window.innerHeight - 8) {
      top = chipRect.top - tooltipRect.height - 6;
    }

    $moveTooltip.css({ left: left + 'px', top: Math.max(8, top) + 'px' });
  }

  function renderLeagueRow(leagueId, leagueDefinitions, leagueResult, viewMode) {
    var def = leagueDefinitions[leagueId];
    var label = '<span class="league-name">' + escapeHtml(def.label) + '</span>';
    var capLabel = def.cpCap === null ? 'No cap' : def.cpCap + ' CP';
    var rowClass = 'league-row-' + leagueId;
    // Shadow's Attack/Defense multipliers apply to battle damage, not to
    // Niantic's CP formula, so the optimal IV/CP/level build itself is
    // identical between Normal and Shadow - only the community rank/score/
    // moveset (a real battle-simulation result) differs, hence swapping
    // just the ranking source here rather than the whole row.
    var ranking = viewMode === 'shadow'
      ? (leagueResult && leagueResult.shadowRanking)
      : (leagueResult && leagueResult.ranking);

    if (!leagueResult || leagueResult.eligible === false) {
      var reason = leagueResult && leagueResult.reason
        ? escapeHtml(leagueResult.reason)
        : 'No valid IV combination fits this cap.';

      return (
        '<tr class="' + rowClass + '">' +
          '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
          '<td class="not-eligible" colspan="3">' + reason + '</td>' +
        '</tr>'
      );
    }

    return (
      '<tr class="' + rowClass + '">' +
        '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
        '<td>' + formatRank(ranking) + '</td>' +
        '<td class="iv-set">' + formatIvSet(leagueResult) + '<br><small>' + leagueResult.cp + ' CP &middot; Lv ' + leagueResult.level + '</small></td>' +
        '<td>' + formatMoveset(ranking) + '</td>' +
      '</tr>'
    );
  }

  function renderTypeAttackerLine(type, info) {
    var label = type.charAt(0).toUpperCase() + type.slice(1);

    if (!info.rank) {
      return '<li>' + escapeHtml(label) + ': <span class="unranked">not ranked</span></li>';
    }

    return (
      '<li>' + escapeHtml(label) + ' attacker: ' + rankBadge(info.rank, info.total) + '</li>'
    );
  }

  function renderAttackerPanel(attacker) {
    if (!attacker) {
      return '<p class="raid-line unranked">Not present in the raid-attacker DPS dataset.</p>';
    }

    var typeLines = Object.keys(attacker.byType)
      .map(function (type) { return renderTypeAttackerLine(type, attacker.byType[type]); })
      .join('');

    var tierLine = attacker.tier
      ? '<span>Community Tier: <strong>' + escapeHtml(attacker.tier.label) + '</strong> ' + rankBadge(attacker.tier.rank, null) + '</span>'
      : '<span class="unranked">Not in the community tier list</span>';

    var formTags = '';
    if (attacker.isMega) { formTags += '<span class="badge tier">Mega</span>'; }
    if (attacker.isShadow) { formTags += '<span class="badge tier">Shadow</span>'; }

    return (
      '<div class="attacker-panel">' +
        '<div class="attacker-stats">' +
          '<div class="attacker-stat"><span>DPS</span><strong>' + attacker.dps + '</strong></div>' +
          '<div class="attacker-stat"><span>TDO</span><strong>' + attacker.tdo + '</strong></div>' +
          '<div class="attacker-stat"><span>ER</span><strong>' + attacker.er + '</strong></div>' +
          '<div class="attacker-stat"><span>Overall Rank</span><strong>' + rankBadge(attacker.overallRank, attacker.totalOverall) + '</strong></div>' +
        '</div>' +
        '<p class="raid-line">Best raid moveset: <strong>' + moveChip(attacker.fastMove) + ' + ' + moveChip(attacker.chargedMove) + '</strong> ' + formTags + '</p>' +
        '<ul class="type-attacker-list">' + typeLines + '</ul>' +
        '<p class="raid-line">' + tierLine + '</p>' +
      '</div>'
    );
  }

  function renderShadowToggle(member, viewMode) {
    if (!member.shadowEligible) {
      return '';
    }

    function toggleBtn(mode, label) {
      var active = mode === viewMode ? ' active' : '';
      return (
        '<button type="button" class="view-toggle-btn' + active + '" data-slug="' + escapeHtml(member.slug) + '" data-mode="' + mode + '">' +
          label +
        '</button>'
      );
    }

    return (
      '<div class="view-toggle">' +
        toggleBtn('normal', 'Normal') +
        toggleBtn('shadow', 'Shadow') +
      '</div>'
    );
  }

  function renderPokemonCard(member, leagueDefinitions, viewMode) {
    viewMode = viewMode === 'shadow' && member.shadowEligible ? 'shadow' : 'normal';

    var typeBadges = member.types
      .map(function (t) { return '<span class="type-badge type-' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; })
      .join('');

    var effectiveAttacker = viewMode === 'shadow' ? member.shadowAttacker : member.attacker;

    // Every badge here is derived straight from a sourced dataset (the
    // community tier list / evolution family data) - no editorial guessing.
    var attackerTier = effectiveAttacker && effectiveAttacker.tier ? effectiveAttacker.tier.label : null;
    var badges = '';
    if (viewMode === 'shadow') {
      badges += '<span class="badge shadow">Shadow</span>';
    }
    if (attackerTier) {
      badges += renderTierBadge(attackerTier);
    }
    badges += member.littleCupEligible
      ? '<span class="badge lc">Little Cup Legal</span>'
      : '<span class="badge lc">Not Little Cup Legal</span>';

    var rows = LEAGUE_ORDER
      .map(function (leagueId) {
        return renderLeagueRow(leagueId, leagueDefinitions, member.leagues[leagueId], viewMode);
      })
      .join('');

    var shadowNote = viewMode === 'shadow'
      ? '<p class="raid-line">Optimal IV/CP/Level builds are identical to Normal &mdash; Shadow\'s +20% Attack / -20% Defense affects battle damage, not Niantic\'s CP formula. Only the ranks, scores, and movesets below reflect the Shadow simulation.</p>'
      : '';

    var heroImg = member.heroImage
      ? '<img class="hero-thumb" src="' + escapeHtml(member.heroImage) + '" alt="" width="80" height="80" loading="lazy">'
      : '';

    return (
      '<article class="pokemon-card' + (viewMode === 'shadow' ? ' shadow-view' : '') + '" id="member-' + escapeHtml(member.slug) + '">' +
        '<div class="pokemon-card-head">' +
          '<div class="pokemon-card-title">' +
            heroImg +
            '<h2><span class="dex">#' + escapeHtml(member.dex) + '</span>' + escapeHtml(member.displayName) + typeBadges + '</h2>' +
          '</div>' +
          renderShadowToggle(member, viewMode) +
        '</div>' +
        '<div class="raid-badges">' + badges + '</div>' +
        shadowNote +
        '<h3 class="section-heading">PvP League Rankings</h3>' +
        '<div class="table-scroll">' +
          '<table class="league-table">' +
            '<thead><tr><th>League</th><th>PvPoke Rank</th><th>Optimal Build (Atk/Def/HP IVs)</th><th>Top Moveset</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<h3 class="section-heading">Raid Attacker Rankings</h3>' +
        renderAttackerPanel(effectiveAttacker) +
      '</article>'
    );
  }

  /**
   * The best (lowest-numbered) PvP league rank a member reaches across all
   * five leagues, used for the family strip's compact "best #N" figure.
   */
  function bestLeagueRank(member) {
    var best = null;
    LEAGUE_ORDER.forEach(function (leagueId) {
      var ranking = member.leagues[leagueId] && member.leagues[leagueId].ranking;
      if (ranking && (best === null || ranking.rank < best.rank)) {
        best = ranking;
      }
    });
    return best;
  }

  function renderFamilyStripItem(member) {
    var best = bestLeagueRank(member);
    var tier = member.attacker && member.attacker.tier ? member.attacker.tier.label : null;
    var tierBadge = tier ? renderTierBadge(tier) : '';
    var rankLine = best
      ? 'best ' + rankBadge(best.rank, null)
      : '<span class="unranked">no PvP rank</span>';
    var icon = member.iconImage
      ? '<img class="family-strip-icon" src="' + escapeHtml(member.iconImage) + '" alt="" width="32" height="32" loading="lazy">'
      : '';

    return (
      '<a class="family-strip-item" href="#member-' + escapeHtml(member.slug) + '">' +
        icon +
        '<div class="family-strip-name">' + escapeHtml(member.displayName) + '</div>' +
        '<div class="family-strip-badges">' + tierBadge + '</div>' +
        '<div class="family-strip-rank">' + rankLine + '</div>' +
      '</a>'
    );
  }

  /**
   * Groups family members by evolutionStage (siblings from a branching
   * family like Eevee share a stage) and renders each stage as a cluster,
   * with a single arrow between stages rather than one between every pair
   * of items - drawing an arrow between siblings would wrongly imply a
   * linear chain through them.
   */
  function renderFamilyStrip(family) {
    if (family.length <= 1) {
      return '';
    }

    var stages = [];
    family.forEach(function (member) {
      var stage = member.evolutionStage || 0;
      stages[stage] = stages[stage] || [];
      stages[stage].push(member);
    });

    var stageHtml = stages
      .filter(function (members) { return members; })
      .map(function (members) {
        return '<div class="family-strip-stage">' + members.map(renderFamilyStripItem).join('') + '</div>';
      })
      .join('<span class="family-strip-arrow">&rarr;</span>');

    return '<div class="family-strip">' + stageHtml + '</div>';
  }

  var NOTABLE_RANK_THRESHOLD = 25;

  /**
   * Scans every ranking figure this app tracks - PvP league rank (both
   * Normal and Shadow), raid-attacker overall rank, per-type attacker
   * rank, and community tier-list rank - across every family member, and
   * collects a plain-language fact for each one that lands in the top 25.
   * Each fact names its specific evolution stage (and Shadow, when that's
   * the variant that qualified) so e.g. a Grotle top-25 finish never gets
   * misread as being about Turtwig or Torterra.
   */
  function collectNotableFacts(family, leagueDefinitions) {
    var facts = [];

    function addFact(rank, html) {
      if (rank && rank <= NOTABLE_RANK_THRESHOLD) {
        facts.push({ rank: rank, html: html });
      }
    }

    family.forEach(function (member) {
      LEAGUE_ORDER.forEach(function (leagueId) {
        var leagueResult = member.leagues[leagueId];
        var leagueLabel = escapeHtml(leagueDefinitions[leagueId].label);
        if (!leagueResult) {
          return;
        }

        [
          { ranking: leagueResult.ranking, shadow: false },
          { ranking: leagueResult.shadowRanking, shadow: true },
        ].forEach(function (variant) {
          if (!variant.ranking) {
            return;
          }
          var name = escapeHtml(member.displayName) + (variant.shadow ? ' <span class="badge shadow">Shadow</span>' : '');
          addFact(
            variant.ranking.rank,
            '<strong>' + name + '</strong> ranks ' + rankBadge(variant.ranking.rank, variant.ranking.totalRanked) +
              ' in ' + leagueLabel + ' <small>(Score ' + variant.ranking.score + ')</small>'
          );
        });
      });

      [
        { attacker: member.attacker, shadow: false },
        { attacker: member.shadowAttacker, shadow: true },
      ].forEach(function (variant) {
        if (!variant.attacker) {
          return;
        }
        var name = escapeHtml(member.displayName) + (variant.shadow ? ' <span class="badge shadow">Shadow</span>' : '');

        addFact(
          variant.attacker.overallRank,
          '<strong>' + name + '</strong> is the ' + rankBadge(variant.attacker.overallRank, variant.attacker.totalOverall) +
            ' best raid attacker overall <small>(DPS ' + variant.attacker.dps + ')</small>'
        );

        Object.keys(variant.attacker.byType).forEach(function (type) {
          var info = variant.attacker.byType[type];
          var typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
          addFact(
            info.rank,
            '<strong>' + name + '</strong> is the ' + rankBadge(info.rank, info.total) + ' best ' + escapeHtml(typeLabel) + ' attacker'
          );
        });

        if (variant.attacker.tier) {
          addFact(
            variant.attacker.tier.rank,
            '<strong>' + name + '</strong> ranks ' + rankBadge(variant.attacker.tier.rank, null) +
              ' on the community attacker tier list <small>(Tier ' + escapeHtml(variant.attacker.tier.label) + ')</small>'
          );
        }
      });
    });

    facts.sort(function (a, b) { return a.rank - b.rank; });

    return facts;
  }

  function renderNotableFacts(family, leagueDefinitions) {
    var facts = collectNotableFacts(family, leagueDefinitions);

    if (facts.length === 0) {
      return '';
    }

    var itemsHtml = facts.map(function (f) { return '<li>' + f.html + '</li>'; }).join('');

    return (
      '<div class="notable-facts">' +
        '<h3 class="section-heading">Notable Rankings <span class="notable-sub">(top ' + NOTABLE_RANK_THRESHOLD + ' finishes)</span></h3>' +
        '<ul>' + itemsHtml + '</ul>' +
      '</div>'
    );
  }

  // Holds the most recent search response so the Normal/Shadow toggle can
  // re-render a single card in place without a fresh AJAX round-trip - the
  // response already contains both variants' data.
  var lastSearchData = null;

  function renderResults(data) {
    $results.empty();
    lastSearchData = data;

    var stripHtml = renderFamilyStrip(data.family);
    var notableHtml = renderNotableFacts(data.family, data.leagueDefinitions);
    // Cards render highest-evolution-first (reverse of the strip above,
    // which still reads base -> final left to right) - purely a display
    // order choice, .slice() first so the strip's own data isn't mutated.
    var cardsHtml = data.family
      .slice()
      .reverse()
      .map(function (member) { return renderPokemonCard(member, data.leagueDefinitions); })
      .join('');

    $results.html(stripHtml + notableHtml + cardsHtml);

    setStatus(
      'Showing the evolution family for "' + escapeHtml(data.query) + '".',
      'info'
    );
  }

  $results.on('click', '.view-toggle-btn', function () {
    if (!lastSearchData) {
      return;
    }

    var slug = $(this).data('slug');
    var mode = $(this).data('mode');
    var member = lastSearchData.family.filter(function (m) { return m.slug === slug; })[0];

    if (!member) {
      return;
    }

    var newCardHtml = renderPokemonCard(member, lastSearchData.leagueDefinitions, mode);
    $('#member-' + slug).replaceWith(newCardHtml);
  });

  /**
   * Reads the recent-searches list from localStorage. Guarded against a
   * missing/unavailable localStorage (private browsing, disabled storage)
   * and against corrupt JSON, since this is purely a cosmetic convenience
   * feature and must never break search itself.
   */
  function getRecentSearches() {
    try {
      var raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Records a successful search at the front of the recent-searches list,
   * de-duplicating by slug (a repeat search moves back to the front rather
   * than appearing twice) and capping at MAX_RECENT_SEARCHES.
   */
  function saveRecentSearch(slug, label) {
    try {
      var existing = getRecentSearches().filter(function (item) { return item.slug !== slug; });
      existing.unshift({ slug: slug, label: label });
      window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(existing.slice(0, MAX_RECENT_SEARCHES)));
    } catch (e) {
      // Storage unavailable/full - recent-searches is a nice-to-have, fail silently.
    }
  }

  function renderRecentSearches() {
    var recent = getRecentSearches();

    if (recent.length === 0) {
      $recentPicks.empty();
      return;
    }

    var buttonsHtml = recent
      .map(function (item) {
        return '<button type="button" class="quick-pick-btn" data-name="' + escapeHtml(item.slug) + '">' +
          escapeHtml(item.label) +
          '</button>';
      })
      .join('');

    $recentPicks.html('Recent: ' + buttonsHtml);
  }

  /**
   * Reduces a string to lowercase letters/digits only, so matching is
   * insensitive to spaces, parentheses, punctuation, and case - typing
   * "ponytagalarian" or "Ponyta (Galarian)" both hit the same key.
   */
  function toSearchKey(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Strips clutter that tools like duplicate-tracking spreadsheets tack
   * onto a copied Pokemon name - superscript numbers (unicode "No"
   * codepoints like U+00B9/U+2074-2079, distinct from plain ASCII digits
   * so "Porygon2" is untouched), emoji, and other symbol/control
   * characters - while keeping the letters, ASCII digits, and the light
   * punctuation (apostrophe, period, hyphen, parens, (fe)male signs)
   * real Pokemon names use. A single interior space is kept between
   * words (not stripped) since the backend needs it to resolve
   * multi-word names like "Mr Mime" or "Tapu Koko"; only repeated/
   * leading/trailing whitespace is collapsed away.
   */
  function sanitizeName(value) {
    return String(value)
      .replace(/[^\p{L}0-9\s'.\-()♀♂]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Fetches the full species list once on page load so autocomplete can
   * filter it entirely client-side (instant, no per-keystroke request).
   * Silently gives up on failure - autocomplete is a convenience layer,
   * search itself doesn't depend on it.
   */
  function loadSpeciesList() {
    $.ajax({ url: 'index.php', method: 'GET', dataType: 'json', data: { action: 'species-list' } })
      .done(function (data) {
        if (data && data.success && Array.isArray(data.species)) {
          allSpecies = data.species.map(function (s) {
            return {
              slug: s.slug,
              label: s.label,
              dex: s.dex,
              types: s.types,
              iconImage: s.iconImage,
              searchKey: toSearchKey(s.label),
              slugKey: toSearchKey(s.slug),
            };
          });
        }
      });
  }

  /**
   * Fetches data.json's "moves" table once on page load so every fast/
   * charged move name shown in the league and raid-attacker tables can
   * become a tappable tooltip trigger (see moveChip() below). Same
   * best-effort, non-blocking approach as loadSpeciesList() - if this
   * hasn't finished by the time a search renders, move names just render
   * as plain text instead of tooltip triggers.
   */
  function loadMovesTable() {
    $.ajax({ url: 'index.php', method: 'GET', dataType: 'json', data: { action: 'moves' } })
      .done(function (data) {
        if (data && data.success && data.moves) {
          movesByKey = data.moves;
        }
      });
  }

  /**
   * Matches the query against each species' name and slug, ranking
   * "starts with" hits above "contains" hits (so typing "pon" surfaces
   * Ponyta before, say, a species that merely contains "pon" mid-word),
   * each group ordered by dex. Capped so the dropdown stays scannable.
   */
  function filterSpecies(query) {
    var key = toSearchKey(query);
    if (key === '') {
      return [];
    }

    var startsWith = [];
    var contains = [];

    for (var i = 0; i < allSpecies.length; i++) {
      var s = allSpecies[i];
      var nameHit = s.searchKey.indexOf(key) !== -1;
      var slugHit = !nameHit && s.slugKey.indexOf(key) !== -1;

      if (!nameHit && !slugHit) {
        continue;
      }

      if (s.searchKey.indexOf(key) === 0 || s.slugKey.indexOf(key) === 0) {
        startsWith.push(s);
      } else {
        contains.push(s);
      }
    }

    return startsWith.concat(contains).slice(0, MAX_AUTOCOMPLETE_RESULTS);
  }

  function renderAutocomplete(matches) {
    autocompleteHighlightIndex = -1;

    if (matches.length === 0) {
      $autocompleteList.empty();
      return;
    }

    var itemsHtml = matches
      .map(function (s) {
        var typeBadges = s.types
          .map(function (t) { return '<span class="type-badge type-' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; })
          .join('');
        var icon = s.iconImage
          ? '<img class="ac-icon" src="' + escapeHtml(s.iconImage) + '" alt="" width="28" height="28" loading="lazy">'
          : '<span class="ac-icon ac-icon-empty"></span>';
        return (
          '<li class="autocomplete-item" data-slug="' + escapeHtml(s.slug) + '">' +
            '<span class="ac-name-group">' + icon + '<span class="ac-dex">#' + s.dex + '</span>' + escapeHtml(s.label) + '</span>' +
            '<span class="ac-types">' + typeBadges + '</span>' +
          '</li>'
        );
      })
      .join('');

    $autocompleteList.html(itemsHtml);
  }

  function closeAutocomplete() {
    $autocompleteList.empty();
    autocompleteHighlightIndex = -1;
  }

  function selectAutocompleteItem($item) {
    if (!$item || $item.length === 0) {
      return;
    }
    $input.val($item.data('slug'));
    closeAutocomplete();
    performSearch();
  }

  function setAutocompleteHighlight(index) {
    var $items = $autocompleteList.find('.autocomplete-item');
    if ($items.length === 0) {
      return;
    }

    autocompleteHighlightIndex = ((index % $items.length) + $items.length) % $items.length;
    $items.removeClass('highlighted');
    var $active = $items.eq(autocompleteHighlightIndex).addClass('highlighted');
    $active.get(0).scrollIntoView({ block: 'nearest' });
  }

  function performSearch() {
    var term = sanitizeName($input.val());
    if (term !== $input.val()) {
      $input.val(term);
    }

    if (term === '') {
      setStatus('Type a Pokemon name first.', 'error');
      return;
    }

    setLoading(true);
    setStatus('Looking up "' + escapeHtml(term) + '"...', 'info');
    $results.empty();

    function handleResult(data) {
      if (data && data.success) {
        renderResults(data);
        var searchedMember = data.family.filter(function (m) { return m.slug === data.resolvedSlug; })[0];
        saveRecentSearch(data.resolvedSlug, searchedMember ? searchedMember.displayName : data.query);
        renderRecentSearches();
      } else {
        var message = (data && data.error) ? data.error : 'Something went wrong. Please try again.';
        setStatus(escapeHtml(message), 'error');
      }
    }

    $.ajax({
      url: 'index.php',
      method: 'GET',
      dataType: 'json',
      data: {
        action: 'search',
        pokemon: term,
      },
    })
      .done(handleResult)
      .fail(function (jqXHR) {
        // index.php uses proper HTTP status codes (400/404/500) for
        // "not found" / bad-input responses, not just 200 - but it always
        // sends a JSON body with a real "error" message. jQuery still
        // parses that body into jqXHR.responseJSON even on a non-2xx
        // status, so use it instead of showing a generic network-error
        // message for what's actually an ordinary "no results" response.
        if (jqXHR.responseJSON) {
          handleResult(jqXHR.responseJSON);
        } else {
          setStatus('Could not reach the server. Please try again in a moment.', 'error');
        }
      })
      .always(function () {
        setLoading(false);
      });
  }

  $searchBtn.on('click', function () {
    closeAutocomplete();
    performSearch();
  });

  $input.on('input', function () {
    renderAutocomplete(filterSpecies($input.val()));
  });

  // Cleans up pasted text specifically (rather than on every keystroke) so
  // normal typing - including a space you just typed before the next word
  // of a multi-word name - is never fought or clobbered mid-type.
  $input.on('paste', function (e) {
    var clipboardData = e.originalEvent && e.originalEvent.clipboardData;
    if (!clipboardData) {
      return;
    }

    e.preventDefault();
    var cleaned = sanitizeName(clipboardData.getData('text'));
    var el = $input.get(0);
    var start = el.selectionStart != null ? el.selectionStart : el.value.length;
    var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    var current = el.value;
    var nextValue = current.slice(0, start) + cleaned + current.slice(end);

    $input.val(nextValue);
    var caret = start + cleaned.length;
    el.setSelectionRange(caret, caret);
    renderAutocomplete(filterSpecies(nextValue));
  });

  $input.on('focus', function () {
    if ($input.val().trim() !== '') {
      renderAutocomplete(filterSpecies($input.val()));
    }
  });

  $input.on('keydown', function (event) {
    var $items = $autocompleteList.find('.autocomplete-item');

    if (event.key === 'ArrowDown') {
      if ($items.length > 0) {
        event.preventDefault();
        setAutocompleteHighlight(autocompleteHighlightIndex + 1);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      if ($items.length > 0) {
        event.preventDefault();
        setAutocompleteHighlight(autocompleteHighlightIndex - 1);
      }
      return;
    }

    if (event.key === 'Escape') {
      closeAutocomplete();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (autocompleteHighlightIndex >= 0 && $items.length > 0) {
        selectAutocompleteItem($items.eq(autocompleteHighlightIndex));
      } else {
        closeAutocomplete();
        performSearch();
      }
    }
  });

  // mousedown (not click) fires before the input's blur handler, so the
  // dropdown is still in the DOM when we read which item was picked -
  // with a plain click, blur would already have wiped it out first.
  $autocompleteList.on('mousedown', '.autocomplete-item', function (event) {
    event.preventDefault();
    selectAutocompleteItem($(this));
  });

  $input.on('blur', function () {
    window.setTimeout(closeAutocomplete, 150);
  });

  // Delegated binding: recent-search buttons are (re)rendered dynamically,
  // so a direct .on('click') bound once at load time wouldn't reach them.
  $recentPicks.on('click', '.quick-pick-btn', function () {
    $input.val($(this).data('name'));
    closeAutocomplete();
    performSearch();
  });

  // Delegated binding: move chips are (re)rendered per search, so this is
  // bound once at load time rather than re-bound after every render.
  $(document).on('click', '.move-chip', function (event) {
    event.stopPropagation();
    var chipEl = this;
    var info = movesByKey[$(this).data('move-key')];

    if (!info) {
      return;
    }

    if (activeMoveChipEl === chipEl) {
      closeMoveTooltip();
      return;
    }

    closeMoveTooltip();
    $(chipEl).addClass('active');
    activeMoveChipEl = chipEl;
    openMoveTooltip(chipEl, info);
  });

  // Closes on an outside click/tap, Escape, or any scroll (including the
  // league table's own horizontal .table-scroll, which doesn't fire a
  // window-level scroll event - listening in the capture phase catches it
  // anyway, since scroll events still propagate to ancestors that way even
  // though they don't bubble).
  $(document).on('click', function (event) {
    if (activeMoveChipEl && !$(event.target).closest('.move-tooltip-popover, .move-chip').length) {
      closeMoveTooltip();
    }
  });
  $(document).on('keydown', function (event) {
    if (event.key === 'Escape') {
      closeMoveTooltip();
    }
  });
  document.addEventListener('scroll', closeMoveTooltip, true);

  renderRecentSearches();
  loadSpeciesList();
  loadMovesTable();
}(jQuery));
