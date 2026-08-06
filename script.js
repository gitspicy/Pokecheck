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

  var $leaderboardView = $('#leaderboard-view');
  var $browseRankingsBtn = $('#browse-rankings-btn');
  // Not exposed by any endpoint since a leaderboard fetch is per-league,
  // but every tab needs to be labeled even before its own data has
  // loaded - matches data.json's leagues[id].label exactly.
  var LEAGUE_LABELS = {
    littleCup: 'Little Cup',
    greatLeague: 'Great League',
    ultraLeague: 'Ultra League',
    masterLeague: 'Master League',
    summerLeague: 'Summer League',
    weatherCup: 'Weather Cup',
  };
  var LEADERBOARD_PAGE_SIZE = 100;
  var leaderboardCache = {}; // leagueId -> {success, league, rows, totalRanked}
  var leaderboardState = { league: 'greatLeague', filterText: '', visibleCount: LEADERBOARD_PAGE_SIZE };

  // Weather Cup sits after Little Cup and Summer League - all three are
  // restricted/seasonal formats grouped together at the end, after the
  // three standard open-ruleset leagues.
  var LEAGUE_ORDER = ['greatLeague', 'ultraLeague', 'masterLeague', 'littleCup', 'summerLeague', 'weatherCup'];

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

  // Image zoom preview: hovering (desktop) or tapping (mobile) any
  // .zoomable-img shows the species' full hero artwork here - see
  // openImageZoom() below.
  var $imageZoom = $(
    '<div class="img-zoom-popover" hidden><img alt="" width="200" height="200"><div class="img-zoom-popover-name"></div></div>'
  ).appendTo('body');
  var activeZoomEl = null;

  // {"1.0": 0.094, "1.5": 0.1351..., ..., "51.0": ...}, fetched once on load
  // (see loadCpMultipliers()) so the "Check Your IVs" tool (renderIvChecker
  // below) can compute CP/level/Stat Product for an arbitrary IV spread
  // entirely client-side - no round trip per IV pick.
  var cpMultipliersTable = null;

  // {normal: {resistances: [...], weaknesses: [...], immunities: [...]}, ...},
  // fetched once on load (see loadTypeChart()) so computeTypeWeaknesses()
  // below can combine a member's own 1-2 types into the "1.6x from
  // Electric / Grass"-style super-effective summary shown on both the main
  // card and the family strip.
  var typeChartTable = null;

  // IV checker: {slug: {league, atk, def, sta, open}}. Persisted here
  // (rather than trusting the live DOM) because the Normal/Shadow toggle
  // fully replaces a card's HTML - without this, tapping it would silently
  // wipe out whatever IVs/league/open-state the user had just set.
  var ivCheckerState = {};

  function getIvCheckerState(slug) {
    if (!ivCheckerState[slug]) {
      ivCheckerState[slug] = { league: 'greatLeague', atk: 0, def: 0, sta: 0, open: false };
    }
    return ivCheckerState[slug];
  }

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

  /**
   * Derives a species' full 260x260 "hero" artwork path from its 56x56
   * "icon" path (both variants are always generated together for every
   * baseStats-covered species - see images/README.md), so any small icon
   * elsewhere in the UI can point its hover/tap zoom preview at the same
   * asset the card header already uses, without a round trip to fetch it.
   * Returns null unmodified - an icon-less attacker (see
   * renderCounterAttacker()) has no hero art either.
   */
  function toHeroSrc(iconSrc) {
    return iconSrc ? iconSrc.replace('images/icon/', 'images/hero/') : null;
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
   * Positions a shared floating popover (fixed positioning, viewport-
   * relative coordinates) directly below the element that triggered it -
   * or above, if there isn't room below - clamped so it never overflows
   * the viewport horizontally either. Shared by the move-detail tooltip
   * and the image zoom preview below; using position:fixed rather than
   * relying on an ancestor's position:relative matters because both can
   * be triggered from inside .table-scroll, which scrolls horizontally
   * and would otherwise clip or misalign an absolutely-positioned popover.
   */
  function positionFloatingPopover($popover, triggerEl) {
    var triggerRect = triggerEl.getBoundingClientRect();
    var popoverRect = $popover.get(0).getBoundingClientRect();

    var left = Math.max(8, Math.min(triggerRect.left, window.innerWidth - popoverRect.width - 8));
    var top = triggerRect.bottom + 6;
    if (top + popoverRect.height > window.innerHeight - 8) {
      top = triggerRect.top - popoverRect.height - 6;
    }

    $popover.css({ left: left + 'px', top: Math.max(8, top) + 'px' });
  }

  function openMoveTooltip(chipEl, info) {
    $moveTooltip.html(formatMoveTooltip(info)).removeAttr('hidden');
    positionFloatingPopover($moveTooltip, chipEl);
  }

  function closeImageZoom() {
    $imageZoom.attr('hidden', true);
    if (activeZoomEl) {
      $(activeZoomEl).removeClass('zoom-active');
    }
    activeZoomEl = null;
  }

  /**
   * Shows imgEl's own data-zoom-src (its species' full 260x260 hero
   * artwork - see renderPokemonCard()/renderFamilyStripItem()/
   * renderCounterAttacker() for how each .zoomable-img gets one) at a
   * readable size next to it. A missing/blank data-zoom-src (an attacker
   * this app has no hero art for at all - see renderCounterAttacker())
   * means there's nothing to zoom into, so this is a no-op.
   */
  function openImageZoom(imgEl) {
    var zoomSrc = imgEl.getAttribute('data-zoom-src');
    if (!zoomSrc) {
      return;
    }

    if (activeZoomEl && activeZoomEl !== imgEl) {
      $(activeZoomEl).removeClass('zoom-active');
    }

    $imageZoom.find('img').attr('src', zoomSrc);
    $imageZoom.find('.img-zoom-popover-name').text(imgEl.getAttribute('data-zoom-name') || '');
    $imageZoom.removeAttr('hidden');
    $(imgEl).addClass('zoom-active');
    activeZoomEl = imgEl;
    positionFloatingPopover($imageZoom, imgEl);
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

  /**
   * One attacker "chip" inside a Top Counters group - icon, display name,
   * DPS, and Mega/Shadow tags where applicable. iconImage can be null even
   * for a real attacker: the DPS ranking covers Mega/fusion forms this
   * app's own baseStats (and therefore its image pipeline) deliberately
   * excludes - see build_counters()'s PHP-side comment - so a blank
   * placeholder swatch stands in rather than a broken image.
   */
  function renderCounterAttacker(attacker) {
    var heroSrc = toHeroSrc(attacker.iconImage);
    var icon = attacker.iconImage
      ? '<img class="counter-attacker-icon zoomable-img" src="' + escapeHtml(attacker.iconImage) + '"' +
          (heroSrc ? ' data-zoom-src="' + escapeHtml(heroSrc) + '" data-zoom-name="' + escapeHtml(attacker.name) + '"' : '') +
          ' alt="" width="40" height="40" loading="lazy">'
      : '<span class="counter-attacker-icon counter-attacker-icon-empty"></span>';

    var tags = '';
    if (attacker.isMega) { tags += '<span class="badge tier">Mega</span>'; }
    if (attacker.isShadow) { tags += '<span class="badge tier">Shadow</span>'; }

    return (
      '<div class="counter-attacker">' +
        icon +
        '<div class="counter-attacker-name">' + escapeHtml(attacker.name) + '</div>' +
        '<div class="counter-attacker-dps">' + attacker.dps + ' DPS</div>' +
        (tags ? '<div class="counter-attacker-tags">' + tags + '</div>' : '') +
      '</div>'
    );
  }

  /**
   * "Top Counters" - who beats this Pokemon, straight from member.counters
   * (index.php's build_counters(): every attacking type it takes
   * super-effective damage from, worst multiplier first, each paired with
   * the top 4 raid attackers of that type from the same DPS ranking the
   * Raid Attacker Rankings section above already reads). A collapsible
   * <details> like Check Your IVs, since this list can run long for a
   * multi-weakness Pokemon and most searches won't need it open.
   */
  function renderCountersPanel(counters) {
    if (!counters || !counters.length) {
      return '';
    }

    var groupsHtml = counters.map(function (group) {
      var multLabel = (Math.round(group.multiplier * 100) / 100) + 'x';
      var typeLabel = group.type.charAt(0).toUpperCase() + group.type.slice(1);
      var attackersHtml = group.attackers.map(renderCounterAttacker).join('');

      return (
        '<div class="counter-group">' +
          '<div class="counter-group-header">' +
            '<span class="type-badge type-' + escapeHtml(group.type) + '">' + escapeHtml(typeLabel) + '</span>' +
            '<span class="weak-mult">' + multLabel + '</span>' +
          '</div>' +
          '<div class="counter-attackers">' + attackersHtml + '</div>' +
        '</div>'
      );
    }).join('');

    return (
      '<details class="counters-panel">' +
        '<summary>Top Counters <span class="iv-summary-hint">best raid attackers against each weakness</span></summary>' +
        '<div class="counters-body">' + groupsHtml + '</div>' +
      '</details>'
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

  // ---------------------------------------------------------------------
  // IV rank checker ("I caught a 13/14/11 X - how good is that?")
  //
  // A client-side twin of index.php's find_optimal_pvp_build()/
  // build_master_league_entry() (calculate_cp() and the level-binary-search
  // are copied verbatim), extended to report where one specific IV spread
  // ranks among all 4096 possible combinations for a species/league cap -
  // PvPoke calls this an "IV rank checker". Runs entirely in the browser,
  // since baseStats/cpCap are already on the page and cpMultipliersTable is
  // fetched once at load (loadCpMultipliers()) - so picking through IVs
  // gets an instant result with no server round trip.
  // ---------------------------------------------------------------------

  function calculateCpClient(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpm) {
    var atk = baseAtk + ivAtk;
    var def = baseDef + ivDef;
    var sta = baseSta + ivSta;
    return Math.floor(atk * Math.sqrt(def) * Math.sqrt(sta) * cpm * cpm / 10);
  }

  function findMaxLevelIndexUnderCapClient(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpCap, cpms) {
    var lastValidIndex = -1;
    var low = 0;
    var high = cpms.length - 1;

    while (low <= high) {
      var mid = Math.floor((low + high) / 2);
      var cp = calculateCpClient(baseAtk, ivAtk, baseDef, ivDef, baseSta, ivSta, cpms[mid]);

      if (cp <= cpCap) {
        lastValidIndex = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return lastValidIndex;
  }

  /**
   * @param baseStats {attack, defense, stamina}
   * @param cpCap number|null (null = Master League, no cap)
   * @return null while cpMultipliersTable hasn't loaded yet, otherwise
   *   {eligible:false} (doesn't fit the cap even at level 1) or
   *   {eligible:true, level, cp, statProduct, rank, totalEligible, percentile}
   */
  function computeIvRank(baseStats, cpCap, targetIvAtk, targetIvDef, targetIvSta) {
    if (!cpMultipliersTable) {
      return null;
    }

    var baseAtk = baseStats.attack;
    var baseDef = baseStats.defense;
    var baseSta = baseStats.stamina;

    function statProductFor(ivAtk, ivDef, ivSta, cpm) {
      var statAtk = (baseAtk + ivAtk) * cpm;
      var statDef = (baseDef + ivDef) * cpm;
      var statHp = Math.floor((baseSta + ivSta) * cpm);
      return Math.round(statAtk * statDef * statHp);
    }

    var target;
    var better = 0;
    var total = 0;
    var pa, pd, ps; // "possible" IV combo being compared against the target

    if (cpCap === null) {
      // Master League: no cap to optimize against, every combo is valid at
      // the same fixed top level (mirrors build_master_league_entry()).
      var topCpm = cpMultipliersTable['51.0'];
      var targetStatProduct = statProductFor(targetIvAtk, targetIvDef, targetIvSta, topCpm);

      for (pa = 0; pa <= 15; pa++) {
        for (pd = 0; pd <= 15; pd++) {
          for (ps = 0; ps <= 15; ps++) {
            total++;
            if (statProductFor(pa, pd, ps, topCpm) > targetStatProduct) {
              better++;
            }
          }
        }
      }

      target = {
        eligible: true,
        level: '51.0',
        cp: calculateCpClient(baseAtk, targetIvAtk, baseDef, targetIvDef, baseSta, targetIvSta, topCpm),
        statProduct: targetStatProduct,
      };
    } else {
      var levelLabels = Object.keys(cpMultipliersTable);
      var cpms = levelLabels.map(function (l) { return cpMultipliersTable[l]; });

      var targetLevelIndex = findMaxLevelIndexUnderCapClient(
        baseAtk, targetIvAtk, baseDef, targetIvDef, baseSta, targetIvSta, cpCap, cpms
      );

      if (targetLevelIndex === -1) {
        return { eligible: false };
      }

      var targetCpm = cpms[targetLevelIndex];
      var targetSp = statProductFor(targetIvAtk, targetIvDef, targetIvSta, targetCpm);

      for (pa = 0; pa <= 15; pa++) {
        for (pd = 0; pd <= 15; pd++) {
          for (ps = 0; ps <= 15; ps++) {
            var levelIndex = findMaxLevelIndexUnderCapClient(baseAtk, pa, baseDef, pd, baseSta, ps, cpCap, cpms);
            if (levelIndex === -1) {
              continue; // doesn't fit the cap even at level 1 - not part of the eligible pool
            }
            total++;
            if (statProductFor(pa, pd, ps, cpms[levelIndex]) > targetSp) {
              better++;
            }
          }
        }
      }

      target = {
        eligible: true,
        level: levelLabels[targetLevelIndex],
        cp: calculateCpClient(baseAtk, targetIvAtk, baseDef, targetIvDef, baseSta, targetIvSta, targetCpm),
        statProduct: targetSp,
      };
    }

    target.rank = better + 1;
    target.totalEligible = total;
    target.percentile = total > 0 ? ((total - better) / total) * 100 : 0;

    return target;
  }

  function ivSelectOptions(selectedValue) {
    var html = '';
    for (var i = 0; i <= 15; i++) {
      html += '<option value="' + i + '"' + (i === selectedValue ? ' selected' : '') + '>' + i + '</option>';
    }
    return html;
  }

  function renderIvChecker(member, leagueDefinitions) {
    var state = getIvCheckerState(member.slug);

    var tabs = LEAGUE_ORDER.map(function (leagueId) {
      var def = leagueDefinitions[leagueId];
      var active = leagueId === state.league ? ' active' : '';
      var capAttr = def.cpCap === null ? 'null' : String(def.cpCap);
      return (
        '<button type="button" class="iv-league-tab iv-tab-' + leagueId + active + '" ' +
          'data-league="' + leagueId + '" data-cp-cap="' + capAttr + '">' +
          escapeHtml(def.label) +
        '</button>'
      );
    }).join('');

    return (
      '<details class="iv-checker" data-slug="' + escapeHtml(member.slug) + '"' +
        ' data-base-atk="' + member.baseStats.attack + '"' +
        ' data-base-def="' + member.baseStats.defense + '"' +
        ' data-base-sta="' + member.baseStats.stamina + '"' +
        (state.open ? ' open' : '') + '>' +
        '<summary>Check Your IVs <span class="iv-summary-hint">see where a real IV spread ranks</span></summary>' +
        '<div class="iv-checker-body">' +
          '<div class="iv-league-tabs">' + tabs + '</div>' +
          '<div class="iv-input-row">' +
            '<label class="iv-input-group">' +
              '<span>Attack</span>' +
              '<select class="iv-select" data-stat="atk">' + ivSelectOptions(state.atk) + '</select>' +
            '</label>' +
            '<label class="iv-input-group">' +
              '<span>Defense</span>' +
              '<select class="iv-select" data-stat="def">' + ivSelectOptions(state.def) + '</select>' +
            '</label>' +
            '<label class="iv-input-group">' +
              '<span>HP</span>' +
              '<select class="iv-select" data-stat="sta">' + ivSelectOptions(state.sta) + '</select>' +
            '</label>' +
          '</div>' +
          '<div class="iv-quick-actions">' +
            '<button type="button" class="iv-quick-btn" data-preset="15,15,15">Perfect (15/15/15)</button>' +
            '<button type="button" class="iv-quick-btn" data-preset="0,0,0">Reset (0/0/0)</button>' +
          '</div>' +
          '<div class="iv-result"></div>' +
        '</div>' +
      '</details>'
    );
  }

  /**
   * Recomputes and redraws one IV checker's result panel from its own
   * current DOM state (active league tab, three <select> values) - called
   * after any interaction, and once eagerly right after each card renders
   * (see initIvCheckers()) so the result is already sitting there the
   * instant a user expands the <details>, not computed on first open.
   */
  function updateIvResult($details) {
    var $result = $details.find('.iv-result');

    if (!cpMultipliersTable) {
      $result.html('<p class="unranked">Loading CP data&hellip;</p>');
      return;
    }

    var baseStats = {
      attack: parseInt($details.data('base-atk'), 10),
      defense: parseInt($details.data('base-def'), 10),
      stamina: parseInt($details.data('base-sta'), 10),
    };

    var $activeTab = $details.find('.iv-league-tab.active');
    var capAttr = $activeTab.attr('data-cp-cap');
    var cpCap = capAttr === 'null' ? null : parseInt(capAttr, 10);

    var ivAtk = parseInt($details.find('.iv-select[data-stat="atk"]').val(), 10);
    var ivDef = parseInt($details.find('.iv-select[data-stat="def"]').val(), 10);
    var ivSta = parseInt($details.find('.iv-select[data-stat="sta"]').val(), 10);

    var slug = $details.data('slug');
    var state = getIvCheckerState(slug);
    state.league = $activeTab.data('league');
    state.atk = ivAtk;
    state.def = ivDef;
    state.sta = ivSta;

    var result = computeIvRank(baseStats, cpCap, ivAtk, ivDef, ivSta);

    if (!result) {
      $result.html('<p class="unranked">Loading CP data&hellip;</p>');
      return;
    }

    if (!result.eligible) {
      $result.html('<p class="not-eligible">Even at level 1, this IV spread exceeds this league\'s CP cap.</p>');
      return;
    }

    $result.html(
      '<div class="iv-result-stats">' +
        '<div class="attacker-stat"><span>CP</span><strong>' + result.cp + '</strong></div>' +
        '<div class="attacker-stat"><span>Level</span><strong>' + result.level + '</strong></div>' +
        '<div class="attacker-stat"><span>Stat Product</span><strong>' + result.statProduct.toLocaleString() + '</strong></div>' +
      '</div>' +
      '<p class="iv-result-rank">' +
        rankBadge(result.rank, result.totalEligible) +
        ' <span class="iv-percentile">better than ' + result.percentile.toFixed(1) + '% of possible IV spreads</span>' +
      '</p>'
    );
  }

  /**
   * Wires up every IV checker within $scope (a freshly-rendered card or
   * the whole results area): binds the native "toggle" event directly
   * (it doesn't bubble, so jQuery delegation from a single document-level
   * handler can't catch it) to persist open/closed state across the
   * Normal/Shadow toggle's full card re-render, and eagerly computes each
   * checker's result once so it's ready the instant it's expanded.
   */
  function initIvCheckers($scope) {
    $scope.find('.iv-checker').each(function () {
      var el = this;
      el.addEventListener('toggle', function () {
        getIvCheckerState($(el).data('slug')).open = el.open;
      });
      updateIvResult($(el));
    });
  }

  var VERDICT_KEEP_THRESHOLD = 25;
  var VERDICT_DECIDE_THRESHOLD = 50;

  /**
   * The single most important thing this app answers: KEEP, OPTIONAL,
   * or TRANSFER, based on the best (lowest-numbered) rank this member
   * reaches across every ranking it tracks - all 5 PvP leagues, raid-
   * attacker overall rank, each of its own types' attacker rank, and
   * community tier rank. Top 25 anywhere is a KEEP, 26-50 is OPTIONAL,
   * anything worse (or a complete unranked blank) is a TRANSFER.
   *
   * Strictly scoped to the given viewMode - a Normal verdict never looks
   * at shadowRanking/shadowAttacker, and a Shadow verdict never looks at
   * the Normal ranking/attacker, so toggling the card is the only way to
   * see the other variant's verdict, never a mix of both at once.
   */
  function computeVerdict(member, viewMode) {
    var best = null; // {rank, source}

    function consider(rank, source) {
      if (rank && (best === null || rank < best.rank)) {
        best = { rank: rank, source: source };
      }
    }

    LEAGUE_ORDER.forEach(function (leagueId) {
      var leagueResult = member.leagues[leagueId];
      if (!leagueResult) {
        return;
      }
      var ranking = viewMode === 'shadow' ? leagueResult.shadowRanking : leagueResult.ranking;
      if (ranking) {
        consider(ranking.rank, LEAGUE_LABELS[leagueId]);
      }
    });

    var attacker = viewMode === 'shadow' ? member.shadowAttacker : member.attacker;
    if (attacker) {
      consider(attacker.overallRank, 'Raid Attacker (Overall)');

      Object.keys(attacker.byType).forEach(function (type) {
        var label = type.charAt(0).toUpperCase() + type.slice(1) + ' Attacker';
        consider(attacker.byType[type].rank, label);
      });

      if (attacker.tier) {
        consider(attacker.tier.rank, 'Community Tier');
      }
    }

    if (best === null) {
      return { tier: 'transfer', label: 'TRANSFER', bestRank: null, bestSource: null };
    }
    if (best.rank <= VERDICT_KEEP_THRESHOLD) {
      return { tier: 'keep', label: 'KEEP', bestRank: best.rank, bestSource: best.source };
    }
    if (best.rank <= VERDICT_DECIDE_THRESHOLD) {
      return { tier: 'decide', label: 'OPTIONAL', bestRank: best.rank, bestSource: best.source };
    }
    return { tier: 'transfer', label: 'TRANSFER', bestRank: best.rank, bestSource: best.source };
  }

  // All 18 Pokemon GO types, used to walk every possible attacking type
  // when combining a member's own defending type(s) - see
  // computeTypeWeaknesses() below.
  var ALL_TYPES = [
    'normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost',
    'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon',
    'dark', 'fairy',
  ];

  /**
   * Combines a member's own 1-2 types into the final super-effective
   * multiplier it takes from each of the 18 attacking types, using
   * data.json's typeEffectiveness chart (fetched by loadTypeChart() -
   * mirrors PvPoke's own DamageCalculator.getEffectiveness()): for each
   * attacking type, each of the member's own defending types contributes
   * its own multiplier (1.6x if that attacking type is one of this
   * defending type's "weaknesses", 0.625x if a "resistance", 0.390625x if
   * an "immunity", else neutral 1x), and the final multiplier is the
   * product across both defending types - e.g. Rock/Fairy vs a Fighting
   * attack is weak (1.6x) on the Rock side but resisted (0.625x) on the
   * Fairy side, netting exactly 1x (no weakness shown at all).
   *
   * Returns only the attacking types whose combined multiplier ends up
   * above neutral, grouped by identical multiplier and sorted worst-first
   * (highest multiplier first), each group's own types alphabetized -
   * e.g. [{multiplier: 2.56, types: ['steel']}, {multiplier: 1.6, types:
   * ['grass', 'ground', 'water']}].
   */
  function computeTypeWeaknesses(types) {
    if (!typeChartTable || !types || !types.length) {
      return [];
    }

    var groups = {}; // roundedMultiplier (string) -> {multiplier, types: []}

    ALL_TYPES.forEach(function (attackType) {
      var multiplier = 1;

      types.forEach(function (defendType) {
        var traits = typeChartTable[defendType];
        if (!traits) {
          return;
        }
        if (traits.weaknesses.indexOf(attackType) !== -1) {
          multiplier *= 1.6;
        } else if (traits.resistances.indexOf(attackType) !== -1) {
          multiplier *= 0.625;
        } else if (traits.immunities.indexOf(attackType) !== -1) {
          multiplier *= 0.390625;
        }
      });

      // Floating point (1.6 * 1.6 = 2.5600000000000005) needs rounding
      // before it can be used as a stable group key.
      var rounded = Math.round(multiplier * 10000) / 10000;
      if (rounded <= 1) {
        return;
      }

      var key = rounded.toFixed(4);
      if (!groups[key]) {
        groups[key] = { multiplier: rounded, types: [] };
      }
      groups[key].types.push(attackType);
    });

    var result = Object.keys(groups).map(function (key) { return groups[key]; });
    result.forEach(function (group) { group.types.sort(); });
    result.sort(function (a, b) { return b.multiplier - a.multiplier; });
    return result;
  }

  /**
   * Renders computeTypeWeaknesses()'s groups as "Weak to:" followed by
   * each group's colored type-badge pills (same .type-badge styling/
   * colors as the header's own type badges, for instant at-a-glance
   * recognition) with that group's multiplier last - e.g. "Weak to:
   * [Steel] 2.56x [Grass][Ground][Water] 1.6x". Returns '' (no element at
   * all) for a Pokemon with no super-effective weaknesses or before the
   * type chart has finished loading, so callers can safely concatenate
   * the result without an empty-container gap.
   */
  function renderTypeWeaknesses(types, wrapperClass) {
    var groups = computeTypeWeaknesses(types);
    if (!groups.length) {
      return '';
    }

    var groupsHtml = groups.map(function (group) {
      var multLabel = (Math.round(group.multiplier * 100) / 100) + 'x';
      var badges = group.types
        .map(function (t) {
          return '<span class="type-badge type-' + escapeHtml(t) + '">' + escapeHtml(t.charAt(0).toUpperCase() + t.slice(1)) + '</span>';
        })
        .join('');
      return '<span class="weak-group">' + badges + '<span class="weak-mult">' + multLabel + '</span></span>';
    });

    return (
      '<div class="' + wrapperClass + '">' +
        '<span class="weak-label">Weak to:</span>' +
        groupsHtml.join('') +
      '</div>'
    );
  }

  function renderVerdictBanner(member, viewMode) {
    var verdict = computeVerdict(member, viewMode);
    var reason = verdict.bestRank
      ? 'Best rank: #' + verdict.bestRank + ' in ' + escapeHtml(verdict.bestSource)
      : 'No top-50 finish in any ranking';

    return (
      '<div class="verdict-banner verdict-' + verdict.tier + '">' +
        '<span class="verdict-label">' + verdict.label + '</span>' +
        '<span class="verdict-reason">' + reason + '</span>' +
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
      ? '<img class="hero-thumb zoomable-img" src="' + escapeHtml(member.heroImage) + '"' +
          ' data-zoom-src="' + escapeHtml(member.heroImage) + '" data-zoom-name="' + escapeHtml(member.displayName) + '"' +
          ' alt="" width="80" height="80" loading="lazy">'
      : '';

    return (
      '<article class="pokemon-card' + (viewMode === 'shadow' ? ' shadow-view' : '') + '" id="member-' + escapeHtml(member.slug) + '">' +
        renderVerdictBanner(member, viewMode) +
        '<div class="pokemon-card-head">' +
          '<div class="pokemon-card-title">' +
            heroImg +
            '<h2><span class="dex">#' + escapeHtml(member.dex) + '</span>' + escapeHtml(member.displayName) + typeBadges + '</h2>' +
          '</div>' +
          renderShadowToggle(member, viewMode) +
        '</div>' +
        '<div class="raid-badges">' + badges + '</div>' +
        renderTypeWeaknesses(member.types, 'type-weaknesses') +
        shadowNote +
        '<h3 class="section-heading">PvP League Rankings</h3>' +
        '<div class="table-scroll">' +
          '<table class="league-table">' +
            '<thead><tr><th>League</th><th>PvPoke Rank</th><th>Optimal Build (Atk/Def/HP IVs)</th><th>Top Moveset</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
        renderIvChecker(member, leagueDefinitions) +
        '<h3 class="section-heading">Raid Attacker Rankings</h3>' +
        renderAttackerPanel(effectiveAttacker) +
        renderCountersPanel(member.counters) +
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
      ? '<img class="family-strip-icon zoomable-img" src="' + escapeHtml(member.iconImage) + '"' +
          (member.heroImage ? ' data-zoom-src="' + escapeHtml(member.heroImage) + '" data-zoom-name="' + escapeHtml(member.displayName) + '"' : '') +
          ' alt="" width="32" height="32" loading="lazy">'
      : '';
    // Always the Normal verdict, matching the tier badge/rank line above -
    // neither reflects any card's Shadow toggle, so the verdict shouldn't
    // either (see computeVerdict()'s own Normal/Shadow scoping note).
    var verdict = computeVerdict(member, 'normal');

    return (
      '<a class="family-strip-item" href="#member-' + escapeHtml(member.slug) + '">' +
        icon +
        '<div class="family-strip-name">' + escapeHtml(member.displayName) + '</div>' +
        '<div class="family-strip-badges">' + tierBadge + '</div>' +
        '<div class="family-strip-rank">' + rankLine + '</div>' +
        '<div class="family-strip-verdict verdict-' + verdict.tier + '">' + verdict.label + '</div>' +
        renderTypeWeaknesses(member.types, 'type-weaknesses family-strip-weaknesses') +
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
    initIvCheckers($results);

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
    var $newCard = $(newCardHtml);
    $('#member-' + slug).replaceWith($newCard);
    initIvCheckers($newCard);
  });

  $results.on('change', '.iv-select', function () {
    updateIvResult($(this).closest('.iv-checker'));
  });

  $results.on('click', '.iv-league-tab', function () {
    var $tab = $(this);
    var $details = $tab.closest('.iv-checker');
    $details.find('.iv-league-tab').removeClass('active');
    $tab.addClass('active');
    updateIvResult($details);
  });

  $results.on('click', '.iv-quick-btn', function () {
    var $details = $(this).closest('.iv-checker');
    var preset = String($(this).attr('data-preset')).split(',');
    $details.find('.iv-select[data-stat="atk"]').val(preset[0]);
    $details.find('.iv-select[data-stat="def"]').val(preset[1]);
    $details.find('.iv-select[data-stat="sta"]').val(preset[2]);
    updateIvResult($details);
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
   *
   * Underscore is allowed too - autocomplete selection, recent-search
   * pills, and leaderboard rows all set the search box directly to a raw
   * slug (e.g. "tapu_koko", "palkia_origin"), not a display name, and
   * this function runs as a safety pass at the top of every
   * performSearch() call. Without it, the underscore joining a multi-word
   * slug's two halves got silently stripped down to "tapukoko" right
   * before the search fired, which the backend then couldn't resolve.
   */
  function sanitizeName(value) {
    return String(value)
      .replace(/[^\p{L}0-9\s'.\-()♀♂_]/gu, '')
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
   * Fetches data.json's "cpMultipliers" table once on page load. Same
   * best-effort approach as loadMovesTable() - if this hasn't finished by
   * the time a card renders, the IV checker just shows a "still loading"
   * message instead of a result until it arrives (see updateIvResult()).
   */
  function loadCpMultipliers() {
    $.ajax({ url: 'index.php', method: 'GET', dataType: 'json', data: { action: 'cp-multipliers' } })
      .done(function (data) {
        if (data && data.success && data.cpMultipliers) {
          cpMultipliersTable = data.cpMultipliers;
          // Multipliers may have finished loading after cards already
          // rendered (e.g. a fast first search) - recompute every checker
          // already on screen (all computed eagerly regardless of open/
          // closed state - see initIvCheckers()) instead of leaving any
          // stuck on "loading".
          $('.iv-checker').each(function () { updateIvResult($(this)); });
        }
      });
  }

  /**
   * Fetches data.json's "typeEffectiveness" chart once on page load so
   * every card/strip's weakness summary (see computeTypeWeaknesses()) can
   * be computed entirely client-side. Same best-effort approach as the
   * other loaders above - if this hasn't finished by the time a search
   * renders, the weakness line is simply omitted, then the whole result
   * set is re-rendered in place once the chart does arrive.
   */
  function loadTypeChart() {
    $.ajax({ url: 'index.php', method: 'GET', dataType: 'json', data: { action: 'type-chart' } })
      .done(function (data) {
        if (data && data.success && data.typeEffectiveness) {
          typeChartTable = data.typeEffectiveness;
          if (lastSearchData) {
            renderResults(lastSearchData);
          }
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

  // ---------------------------------------------------------------------
  // League leaderboard browser ("Browse Rankings") - lets a user explore
  // a league's full ranked list rather than only ever looking up one
  // species at a time. All 5 leagues are selectable via the same tab
  // styling the IV checker uses.
  // ---------------------------------------------------------------------

  function loadLeaderboard(leagueId) {
    if (leaderboardCache[leagueId]) {
      return $.Deferred().resolve(leaderboardCache[leagueId]).promise();
    }

    return $.ajax({ url: 'index.php', method: 'GET', dataType: 'json', data: { action: 'leaderboard', league: leagueId } })
      .done(function (data) {
        if (data && data.success) {
          leaderboardCache[leagueId] = data;
        }
      });
  }

  /**
   * One leaderboard entry, resolved rows as a tappable button (jumps to
   * that species' card via a normal search) and unresolved rows (mostly
   * Mega entries this app doesn't track as species - see
   * get_league_leaderboard()'s comment) as plain, non-interactive text.
   */
  function renderLeaderboardRow(row) {
    var inner = (
      '<span class="leaderboard-row-rank">#' + row.rank + '</span>' +
      '<span class="leaderboard-row-name"><strong>' + escapeHtml(row.name) + '</strong></span>' +
      '<span class="leaderboard-row-moveset">' +
        moveChip(row.fastMove) +
        (row.chargedMove1 ? '<br>' + moveChip(row.chargedMove1) + (row.chargedMove2 ? ' + ' + moveChip(row.chargedMove2) : '') : '') +
      '</span>' +
      (row.score !== null
        ? '<span class="leaderboard-row-score"><strong>' + row.score + '</strong>Score</span>'
        : '<span class="leaderboard-row-score">&mdash;</span>')
    );

    return row.resolvedSlug
      ? '<button type="button" class="leaderboard-row" data-slug="' + escapeHtml(row.resolvedSlug) + '">' + inner + '</button>'
      : '<div class="leaderboard-row is-unresolved">' + inner + '</div>';
  }

  /**
   * Redraws just the filtered/paginated row list (not the tabs or filter
   * <input> itself) - called on every filter keystroke, so the input
   * never loses focus the way a full-view re-render would.
   */
  function renderLeaderboardResults() {
    var $target = $leaderboardView.find('.leaderboard-results');
    var data = leaderboardCache[leaderboardState.league];

    if (!data) {
      $target.html('<p class="unranked">Loading&hellip;</p>');
      return;
    }

    var filterKey = leaderboardState.filterText.trim().toLowerCase();
    var filtered = filterKey === ''
      ? data.rows
      : data.rows.filter(function (r) { return r.name.toLowerCase().indexOf(filterKey) !== -1; });

    var visible = filtered.slice(0, leaderboardState.visibleCount);
    var remaining = filtered.length - visible.length;

    var rowsHtml = visible.length > 0
      ? visible.map(renderLeaderboardRow).join('')
      : '<p class="unranked">No matches.</p>';

    var showMoreHtml = remaining > 0
      ? '<button type="button" class="leaderboard-show-more">Show ' + Math.min(LEADERBOARD_PAGE_SIZE, remaining) + ' more (' + remaining + ' remaining)</button>'
      : '';

    $target.html(
      '<p class="leaderboard-meta">' + filtered.length + ' of ' + data.totalRanked + ' ranked' + (filterKey ? ' (filtered)' : '') + '</p>' +
      '<div class="leaderboard-list">' + rowsHtml + '</div>' +
      showMoreHtml
    );
  }

  function ensureLeaderboardLoaded(leagueId) {
    if (leaderboardCache[leagueId]) {
      return;
    }

    function handleFailure() {
      if (leaderboardState.league === leagueId) {
        $leaderboardView.find('.leaderboard-results').html('<p class="unranked">Could not load this league\'s rankings.</p>');
      }
    }

    loadLeaderboard(leagueId)
      .done(function (data) {
        if (leaderboardState.league !== leagueId) {
          return; // the user switched tabs again before this resolved
        }
        if (!data || !data.success) {
          handleFailure();
          return;
        }
        renderLeaderboardResults();
      })
      // index.php returns a real 400/404 status for "unknown league" /
      // "no ranking data" (see handle_leaderboard_request()), which
      // jQuery routes to .fail() rather than .done() even though the
      // body is still valid JSON - same convention as performSearch()'s
      // own .fail() handler.
      .fail(handleFailure);
  }

  /** Redraws the whole view (tabs, filter input, results) - only needed on open or a league switch. */
  function renderLeaderboardShell() {
    var tabs = LEAGUE_ORDER.map(function (leagueId) {
      var active = leagueId === leaderboardState.league ? ' active' : '';
      return (
        '<button type="button" class="iv-league-tab iv-tab-' + leagueId + active + '" data-league="' + leagueId + '">' +
          escapeHtml(LEAGUE_LABELS[leagueId]) +
        '</button>'
      );
    }).join('');

    $leaderboardView.html(
      '<div class="leaderboard-header">' +
        '<h2>Browse Rankings</h2>' +
        '<button type="button" class="leaderboard-close-btn" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="iv-league-tabs">' + tabs + '</div>' +
      '<input type="text" class="leaderboard-filter" placeholder="Filter by name" value="' + escapeHtml(leaderboardState.filterText) + '">' +
      '<div class="leaderboard-results"></div>'
    );

    renderLeaderboardResults();
  }

  // jQuery's .hide()/.show() (not the hidden attribute alone) because
  // #results already carries its own "display: flex" rule, which - being
  // an ID selector - beats the browser's default [hidden] { display:
  // none } (an attribute selector); toggling just the attribute would
  // silently do nothing. The hidden attribute is still kept in sync
  // alongside it for assistive tech that reads it directly.
  function openLeaderboardView() {
    $results.hide().attr('hidden', true);
    $leaderboardView.show().removeAttr('hidden');
    $browseRankingsBtn.addClass('active').text('Close Rankings');
    renderLeaderboardShell();
    ensureLeaderboardLoaded(leaderboardState.league);
  }

  function closeLeaderboardView() {
    $leaderboardView.hide().attr('hidden', true);
    $results.show().removeAttr('hidden');
    $browseRankingsBtn.removeClass('active').text('Browse Rankings');
  }

  $browseRankingsBtn.on('click', function () {
    if ($leaderboardView.is(':hidden')) {
      openLeaderboardView();
    } else {
      closeLeaderboardView();
    }
  });

  $leaderboardView.on('click', '.leaderboard-close-btn', function () {
    closeLeaderboardView();
  });

  $leaderboardView.on('click', '.iv-league-tab', function () {
    var leagueId = $(this).data('league');
    if (leagueId === leaderboardState.league) {
      return;
    }
    leaderboardState.league = leagueId;
    leaderboardState.filterText = '';
    leaderboardState.visibleCount = LEADERBOARD_PAGE_SIZE;
    renderLeaderboardShell();
    ensureLeaderboardLoaded(leagueId);
  });

  $leaderboardView.on('input', '.leaderboard-filter', function () {
    leaderboardState.filterText = $(this).val();
    leaderboardState.visibleCount = LEADERBOARD_PAGE_SIZE;
    renderLeaderboardResults();
  });

  $leaderboardView.on('click', '.leaderboard-show-more', function () {
    leaderboardState.visibleCount += LEADERBOARD_PAGE_SIZE;
    renderLeaderboardResults();
  });

  $leaderboardView.on('click', '.leaderboard-row[data-slug]', function () {
    var slug = $(this).data('slug');
    closeLeaderboardView();
    $input.val(slug);
    performSearch();
  });

  function performSearch() {
    var term = sanitizeName($input.val());
    if (term !== $input.val()) {
      $input.val(term);
    }

    if (term === '') {
      setStatus('Type a Pokemon name first.', 'error');
      return;
    }

    closeLeaderboardView();
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
    // Mobile only: tapping into an already-filled search box is far more
    // likely to mean "search for something else" than "edit this text",
    // and placing a cursor to backspace out an old entry is fiddly on a
    // touch keyboard - clear it immediately instead. Left alone on the
    // web app, where mouse/keyboard editing (double-click, Ctrl+A, etc.)
    // doesn't have that same friction.
    if (isStandaloneApp() && $input.val().trim() !== '') {
      $input.val('');
    }

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

  // True hover, desktop only (touch devices don't fire mouseenter/
  // mouseleave from a tap) - jQuery's delegated mouseenter/mouseleave
  // already handle the "don't refire on child element changes" logic
  // native mouseover/mouseout would otherwise need.
  $(document).on('mouseenter', '.zoomable-img', function () {
    openImageZoom(this);
  });
  $(document).on('mouseleave', '.zoomable-img', function () {
    if (activeZoomEl === this) {
      closeImageZoom();
    }
  });

  // Touch/click: several .zoomable-img elements sit inside something else
  // tappable (a family-strip-item link, an autocomplete-style selection)
  // - preventDefault/stopPropagation here means the first tap on the
  // image itself always shows the zoom instead of immediately navigating,
  // exactly like tapping a move-chip already does above. A second tap on
  // the same (already-zoomed) image closes it again.
  $(document).on('click', '.zoomable-img', function (event) {
    event.preventDefault();
    event.stopPropagation();

    if (activeZoomEl === this) {
      closeImageZoom();
      return;
    }

    openImageZoom(this);
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
    if (activeZoomEl && !$(event.target).closest('.img-zoom-popover, .zoomable-img').length) {
      closeImageZoom();
    }
  });
  $(document).on('keydown', function (event) {
    if (event.key === 'Escape') {
      closeMoveTooltip();
      closeImageZoom();
    }
  });
  document.addEventListener('scroll', closeMoveTooltip, true);
  document.addEventListener('scroll', closeImageZoom, true);

  // ---------------------------------------------------------------------
  // Settings panel + in-app update checker - standalone Android app only.
  // The web app has no APK to update, so this whole panel stays hidden
  // there; isStandaloneApp() is the same "does PvPEngine exist" signal
  // localAction() itself depends on in the mobile-app copy of this file,
  // making it a reliable way for this ONE shared script.js to behave
  // differently per platform without needing a build-time branch.
  //
  // This is the one deliberate exception to the app's "no network calls"
  // design: GitHub's public Releases API (no auth token needed for a
  // public repo) is only ever queried when the user explicitly taps
  // "Check for Updates" - never automatically, never in the background.
  // The actual download is handed off to the system browser (via
  // Capacitor's Browser plugin where available, falling back to a
  // plain window.open() e.g. when this file is loaded in a regular
  // browser with no Capacitor bridge, as in local testing) rather than
  // silently downloaded and installed in-app - installing a package is a
  // sensitive OS-level action best left to Android's own, already-
  // trusted download/install flow instead of custom native code here.
  // ---------------------------------------------------------------------

  var $settingsBtn = $('#settings-btn');
  var $settingsPanel = $('#settings-panel');
  var GITHUB_REPO = 'gitspicy/Pokecheck';
  var UPDATE_RELEASE_TAG = 'mobile-latest';
  var appVersionInfo = null; // {sha, builtAt}, loaded from version.json (generated at CI build time)

  function isStandaloneApp() {
    return typeof window.PvPEngine !== 'undefined';
  }

  function openExternalUrl(url) {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url: url });
    } else {
      window.open(url, '_blank');
    }
  }

  function loadAppVersion() {
    return $.ajax({ url: 'version.json', dataType: 'json' })
      .done(function (data) {
        appVersionInfo = data;
      });
  }

  function renderSettingsPanel() {
    var versionLine = appVersionInfo
      ? 'Build ' + escapeHtml(appVersionInfo.sha) + (appVersionInfo.builtAt ? ' &middot; ' + escapeHtml(String(appVersionInfo.builtAt).slice(0, 10)) : '')
      : 'Unknown build';

    $settingsPanel.html(
      '<div class="settings-panel-body">' +
        '<h2>Settings</h2>' +
        '<div class="settings-row"><span>App version</span><span>' + versionLine + '</span></div>' +
        '<button type="button" class="settings-update-btn" id="check-updates-btn">Check for Updates</button>' +
        '<div class="settings-update-result" id="settings-update-result"></div>' +
      '</div>'
    );
  }

  function checkForUpdates() {
    var $btn = $('#check-updates-btn');
    var $result = $('#settings-update-result');

    $btn.prop('disabled', true).text('Checking...');
    $result.removeClass('update-available update-error').empty();

    $.ajax({
      url: 'https://api.github.com/repos/' + GITHUB_REPO + '/git/refs/tags/' + UPDATE_RELEASE_TAG,
      dataType: 'json',
    }).done(function (refData) {
      var remoteSha = refData && refData.object ? refData.object.sha : null;
      var localSha = appVersionInfo ? appVersionInfo.sha : null;

      if (!remoteSha || !localSha) {
        $result.addClass('update-error').text('Could not determine the latest version.');
        $btn.prop('disabled', false).text('Check for Updates');
        return;
      }

      if (remoteSha.indexOf(localSha) === 0) {
        $result.text('You\'re up to date (build ' + escapeHtml(localSha) + ').');
        $btn.prop('disabled', false).text('Check for Updates');
        return;
      }

      $.ajax({
        url: 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/tags/' + UPDATE_RELEASE_TAG,
        dataType: 'json',
      }).done(function (releaseData) {
        var assets = (releaseData && releaseData.assets) || [];
        var apkAsset = assets.filter(function (a) { return /\.apk$/i.test(a.name); })[0];

        $btn.prop('disabled', false).text('Check for Updates');

        if (!apkAsset) {
          $result.addClass('update-error').text('A new build exists but no APK was found to download.');
          return;
        }

        $result.addClass('update-available').html(
          'Update available (build ' + escapeHtml(remoteSha.slice(0, 7)) + ').<br>' +
          '<button type="button" class="settings-update-btn" id="download-update-btn">Download Update</button>'
        );

        $('#download-update-btn').on('click', function () {
          openExternalUrl(apkAsset.browser_download_url);
        });
      }).fail(function () {
        $btn.prop('disabled', false).text('Check for Updates');
        $result.addClass('update-error').text('Found a newer build but could not load its download link.');
      });
    }).fail(function () {
      $btn.prop('disabled', false).text('Check for Updates');
      $result.addClass('update-error').text('Could not check for updates. Check your connection.');
    });
  }

  if (isStandaloneApp()) {
    $settingsBtn.removeAttr('hidden');
    loadAppVersion();
  }

  $settingsBtn.on('click', function () {
    if ($settingsPanel.is('[hidden]')) {
      renderSettingsPanel();
      $settingsPanel.removeAttr('hidden');
      $settingsBtn.addClass('active');
    } else {
      $settingsPanel.attr('hidden', true);
      $settingsBtn.removeClass('active');
    }
  });

  $settingsPanel.on('click', '#check-updates-btn', function () {
    checkForUpdates();
  });

  renderRecentSearches();
  loadSpeciesList();
  loadMovesTable();
  loadCpMultipliers();
  loadTypeChart();
}(jQuery));
