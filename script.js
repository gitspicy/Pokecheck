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

  function renderLeagueRow(leagueId, leagueDefinitions, leagueResult) {
    var def = leagueDefinitions[leagueId];
    var label = escapeHtml(def.label);
    var capLabel = def.cpCap === null ? 'No cap' : def.cpCap + ' CP';

    if (!leagueResult || leagueResult.eligible === false) {
      var reason = leagueResult && leagueResult.reason
        ? escapeHtml(leagueResult.reason)
        : 'No valid IV combination fits this cap.';

      return (
        '<tr>' +
          '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
          '<td class="not-eligible" colspan="3">' + reason + '</td>' +
        '</tr>'
      );
    }

    return (
      '<tr>' +
        '<td>' + label + '<br><small>' + capLabel + '</small></td>' +
        '<td class="iv-set">' + formatIvSet(leagueResult) + '</td>' +
        '<td>' + leagueResult.cp + ' CP</td>' +
        '<td>Lv ' + leagueResult.level + '</td>' +
      '</tr>'
    );
  }

  function renderPokemonCard(member, leagueDefinitions) {
    var typeBadges = member.types
      .map(function (t) { return '<span class="type-badge">' + escapeHtml(t) + '</span>'; })
      .join('');

    var raid = member.raid;
    var badges = '<span class="badge tier">Raid Tier ' + escapeHtml(raid.attackerTier) + '</span>';
    if (raid.isTopAttacker) {
      badges += '<span class="badge attacker">Top Raid Attacker</span>';
    }
    if (raid.isGymDefender) {
      badges += '<span class="badge defender">Gym Defender</span>';
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
      '<article class="pokemon-card">' +
        '<div class="pokemon-card-head">' +
          '<h2><span class="dex">#' + escapeHtml(member.dex) + '</span>' + escapeHtml(member.displayName) + typeBadges + '</h2>' +
        '</div>' +
        '<div class="raid-badges">' + badges + '</div>' +
        '<p class="raid-line">' + escapeHtml(raid.role) + '</p>' +
        '<table class="league-table">' +
          '<thead><tr><th>League</th><th>Optimal IVs (Atk/Def/HP)</th><th>Max CP</th><th>Level</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</article>'
    );
  }

  function renderResults(data) {
    $results.empty();

    var cardsHtml = data.family
      .map(function (member) { return renderPokemonCard(member, data.leagueDefinitions); })
      .join('');

    $results.html(cardsHtml);

    var sourceNote = data.dataSource === 'fallback'
      ? ' (offline fallback family data used - PokeAPI was unreachable)'
      : '';

    setStatus(
      'Showing the evolution family for "' + escapeHtml(data.query) + '"' + sourceNote + '.',
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

    $.ajax({
      url: 'index.php',
      method: 'GET',
      dataType: 'json',
      data: {
        action: 'search',
        pokemon: term,
      },
    })
      .done(function (data) {
        if (data && data.success) {
          renderResults(data);
        } else {
          var message = (data && data.error) ? data.error : 'Something went wrong. Please try again.';
          setStatus(escapeHtml(message), 'error');
        }
      })
      .fail(function () {
        setStatus('Could not reach the server. Please try again in a moment.', 'error');
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
