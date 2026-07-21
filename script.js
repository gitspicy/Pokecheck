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

  var LEAGUE_ORDER = ['littleCup', 'greatLeague', 'summerLeague', 'ultraLeague', 'masterLeague'];
  var TOP_ATTACKER_TIERS = ['S', 'SS', 'SSS', 'SSSS', 'SSSSS'];

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

  function formatMoveset(ranking) {
    if (!ranking) {
      return '<span class="unranked">&mdash;</span>';
    }
    return (
      escapeHtml(ranking.fastMove) +
      '<br><small>' + escapeHtml(ranking.chargedMove1) + ' + ' + escapeHtml(ranking.chargedMove2) + '</small>'
    );
  }

  function renderLeagueRow(leagueId, leagueDefinitions, leagueResult) {
    var def = leagueDefinitions[leagueId];
    var label = '<span class="league-name">' + escapeHtml(def.label) + '</span>';
    var capLabel = def.cpCap === null ? 'No cap' : def.cpCap + ' CP';
    var rowClass = 'league-row-' + leagueId;

    if (!leagueResult || leagueResult.eligible === false) {
      var reason = leagueResult && leagueResult.reason
        ? escapeHtml(leagueResult.reason)
        : 'No valid IV combination fits this cap.';

      return (
        '<tr class="' + rowClass + '">' +
          '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
          '<td class="not-eligible" colspan="4">' + reason + '</td>' +
        '</tr>'
      );
    }

    return (
      '<tr class="' + rowClass + '">' +
        '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
        '<td class="iv-set">' + formatIvSet(leagueResult) + '<br><small>' + leagueResult.cp + ' CP &middot; Lv ' + leagueResult.level + '</small></td>' +
        '<td>' + formatRank(leagueResult.ranking) + '</td>' +
        '<td>' + formatMoveset(leagueResult.ranking) + '</td>' +
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
        '<p class="raid-line">Best raid moveset: <strong>' + escapeHtml(attacker.fastMove) + ' + ' + escapeHtml(attacker.chargedMove) + '</strong> ' + formTags + '</p>' +
        '<ul class="type-attacker-list">' + typeLines + '</ul>' +
        '<p class="raid-line">' + tierLine + '</p>' +
      '</div>'
    );
  }

  function renderPokemonCard(member, leagueDefinitions) {
    var typeBadges = member.types
      .map(function (t) { return '<span class="type-badge type-' + escapeHtml(t) + '">' + escapeHtml(t) + '</span>'; })
      .join('');

    // Every badge here is derived straight from a sourced dataset (the
    // community tier list / evolution family data) - no editorial guessing.
    var attackerTier = member.attacker && member.attacker.tier ? member.attacker.tier.label : null;
    var badges = '';
    if (attackerTier && TOP_ATTACKER_TIERS.indexOf(attackerTier) !== -1) {
      badges += '<span class="badge attacker">Top Raid Attacker (Tier ' + escapeHtml(attackerTier) + ')</span>';
    } else if (attackerTier) {
      badges += '<span class="badge tier">Tier ' + escapeHtml(attackerTier) + '</span>';
    }
    badges += member.littleCupEligible
      ? '<span class="badge lc">Little Cup Legal</span>'
      : '<span class="badge lc">Not Little Cup Legal</span>';

    var rows = LEAGUE_ORDER
      .map(function (leagueId) {
        return renderLeagueRow(leagueId, leagueDefinitions, member.leagues[leagueId]);
      })
      .join('');

    return (
      '<article class="pokemon-card" id="member-' + escapeHtml(member.slug) + '">' +
        '<div class="pokemon-card-head">' +
          '<h2><span class="dex">#' + escapeHtml(member.dex) + '</span>' + escapeHtml(member.displayName) + typeBadges + '</h2>' +
        '</div>' +
        '<div class="raid-badges">' + badges + '</div>' +
        '<h3 class="section-heading">PvP League Rankings</h3>' +
        '<div class="table-scroll">' +
          '<table class="league-table">' +
            '<thead><tr><th>League</th><th>Optimal Build (Atk/Def/HP IVs)</th><th>PvPoke Rank</th><th>Top Moveset</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<h3 class="section-heading">Raid Attacker Rankings</h3>' +
        renderAttackerPanel(member.attacker) +
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
    var tierBadge = tier ? '<span class="badge tier">Tier ' + escapeHtml(tier) + '</span>' : '';
    var rankLine = best
      ? 'best ' + rankBadge(best.rank, null)
      : '<span class="unranked">no PvP rank</span>';

    return (
      '<a class="family-strip-item" href="#member-' + escapeHtml(member.slug) + '">' +
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

  function renderResults(data) {
    $results.empty();

    var stripHtml = renderFamilyStrip(data.family);
    var cardsHtml = data.family
      .map(function (member) { return renderPokemonCard(member, data.leagueDefinitions); })
      .join('');

    $results.html(stripHtml + cardsHtml);

    setStatus(
      'Showing the evolution family for "' + escapeHtml(data.query) + '".',
      'info'
    );
  }

  function performSearch() {
    var term = $input.val().trim();

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

  $searchBtn.on('click', performSearch);

  $input.on('keypress', function (event) {
    if (event.which === 13) {
      event.preventDefault();
      performSearch();
    }
  });

  $('.quick-pick-btn').on('click', function () {
    $input.val($(this).data('name'));
    performSearch();
  });
}(jQuery));
