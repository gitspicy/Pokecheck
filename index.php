<?php
/**
 * Pokemon GO PvP Reference App - single backend file.
 *
 * Two responsibilities live here:
 *  1. AJAX endpoint  (?action=search&pokemon=NAME) -> returns JSON with the
 *     searched Pokemon's evolution family and their optimal PvP IV builds.
 *  2. Page renderer  (no action param) -> outputs the static HTML shell that
 *     script.js talks to.
 *
 * No database and no local write access are required. All static reference
 * data (CP multipliers, GO base stats, league rules) lives in data.json.
 * The only outbound network call this app makes is to the public PokeAPI
 * evolution-chain endpoints, used purely to discover which species belong
 * to a Pokemon's family line - never for stats.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Loads and decodes data.json once per request.
 *
 * @return array<string,mixed>
 */
function load_game_data(): array
{
    static $cached = null;

    if ($cached !== null) {
        return $cached;
    }

    $path = __DIR__ . '/data.json';
    $raw = file_get_contents($path);

    if ($raw === false) {
        throw new RuntimeException('Unable to read data.json.');
    }

    $decoded = json_decode($raw, true);

    if (!is_array($decoded)) {
        throw new RuntimeException('data.json is not valid JSON.');
    }

    $cached = $decoded;

    return $cached;
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw search term into a PokeAPI-safe species slug
 * (lowercase, hyphen-separated, alphanumeric only).
 *
 * @return string|null Null when the input contains no usable characters.
 */
function normalize_species_slug(string $raw): ?string
{
    $trimmed = trim($raw);

    if ($trimmed === '' || mb_strlen($trimmed) > 40) {
        return null;
    }

    $lower = mb_strtolower($trimmed);
    // Collapse whitespace/apostrophes/periods into hyphens (e.g. "Mr. Mime" -> "mr-mime"),
    // then strip anything that isn't a lowercase letter, digit, or hyphen.
    $slug = preg_replace('/[\s\'\.]+/', '-', $lower);
    $slug = preg_replace('/[^a-z0-9\-]/', '', (string) $slug);
    $slug = preg_replace('/-+/', '-', (string) $slug);
    $slug = trim((string) $slug, '-');

    return $slug === '' ? null : $slug;
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (used only for the PokeAPI evolution-chain lookups)
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and decodes it as JSON. Returns null on any failure
 * (network error, non-200 response, invalid JSON) so callers can fall
 * back gracefully instead of crashing the request.
 *
 * @return array<string,mixed>|null
 */
function fetch_remote_json(string $url, int $timeoutSeconds = 6): ?array
{
    $userAgent = 'PokecheckPvPReference/1.0 (+https://github.com/gitspicy/pokecheck)';

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeoutSeconds,
            CURLOPT_CONNECTTIMEOUT => $timeoutSeconds,
            CURLOPT_HTTPHEADER => ['Accept: application/json'],
            CURLOPT_USERAGENT => $userAgent,
        ]);
        $body = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($body === false || $status !== 200) {
            return null;
        }
    } elseif (ini_get('allow_url_fopen')) {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "Accept: application/json\r\nUser-Agent: {$userAgent}\r\n",
                'timeout' => $timeoutSeconds,
                'ignore_errors' => true,
            ],
        ]);
        $body = @file_get_contents($url, false, $context);

        $status = 0;
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $status = (int) $m[1];
        }

        if ($body === false || $status !== 200) {
            return null;
        }
    } else {
        // No network transport available in this PHP build.
        return null;
    }

    $decoded = json_decode($body, true);

    return is_array($decoded) ? $decoded : null;
}

// ---------------------------------------------------------------------------
// Evolution family resolution (PokeAPI, with local fallback)
// ---------------------------------------------------------------------------

/**
 * Recursively flattens a PokeAPI evolution-chain "chain" node into an
 * ordered list of species slugs, and records which slugs have at least
 * one further evolution (used for the Little Cup eligibility flag).
 *
 * @param array<string,mixed> $node
 * @param string[] $orderedNames
 * @param array<string,bool> $hasNextEvolution
 */
function flatten_evolution_chain(array $node, array &$orderedNames, array &$hasNextEvolution): void
{
    $name = isset($node['species']['name']) ? (string) $node['species']['name'] : null;

    if ($name === null) {
        return;
    }

    $orderedNames[] = $name;
    $children = isset($node['evolves_to']) && is_array($node['evolves_to']) ? $node['evolves_to'] : [];
    $hasNextEvolution[$name] = count($children) > 0;

    foreach ($children as $child) {
        if (is_array($child)) {
            flatten_evolution_chain($child, $orderedNames, $hasNextEvolution);
        }
    }
}

/**
 * Resolves the full evolution family for a species slug.
 *
 * Tries the live PokeAPI first (species -> evolution_chain), and falls
 * back to data.json's fallbackFamilies map if the network call fails.
 *
 * @param array<string,mixed> $gameData
 * @return array{names: string[], hasNextEvolution: array<string,bool>, source: string}|null
 */
function resolve_evolution_family(string $slug, array $gameData): ?array
{
    $speciesData = fetch_remote_json("https://pokeapi.co/api/v2/pokemon-species/{$slug}");

    if ($speciesData !== null && isset($speciesData['evolution_chain']['url'])) {
        $chainData = fetch_remote_json((string) $speciesData['evolution_chain']['url']);

        if ($chainData !== null && isset($chainData['chain']) && is_array($chainData['chain'])) {
            $orderedNames = [];
            $hasNextEvolution = [];
            flatten_evolution_chain($chainData['chain'], $orderedNames, $hasNextEvolution);

            if (in_array($slug, $orderedNames, true)) {
                return [
                    'names' => $orderedNames,
                    'hasNextEvolution' => $hasNextEvolution,
                    'source' => 'pokeapi',
                ];
            }
        }
    }

    // Fall back to the small local family map so the app keeps working
    // offline / when PokeAPI is unreachable, for the demo species we ship.
    $fallback = $gameData['fallbackFamilies'][$slug] ?? null;

    if (is_array($fallback)) {
        $hasNextEvolution = [];
        foreach ($fallback as $index => $name) {
            $hasNextEvolution[$name] = $index < count($fallback) - 1;
        }

        return [
            'names' => $fallback,
            'hasNextEvolution' => $hasNextEvolution,
            'source' => 'fallback',
        ];
    }

    return null;
}

// ---------------------------------------------------------------------------
// PvP IV calculator
// ---------------------------------------------------------------------------

/**
 * Computes CP for a given stat line and CP multiplier.
 * This is Niantic's official CP formula.
 */
function calculate_cp(int $baseAtk, int $ivAtk, int $baseDef, int $ivDef, int $baseSta, int $ivSta, float $cpm): int
{
    $atk = $baseAtk + $ivAtk;
    $def = $baseDef + $ivDef;
    $sta = $baseSta + $ivSta;

    return (int) floor($atk * sqrt($def) * sqrt($sta) * $cpm * $cpm / 10);
}

/**
 * Finds the highest level (as an index into $levels/$cpms) at which the
 * given IV spread stays at or under the CP cap. Returns -1 if even the
 * lowest level (index 0) exceeds the cap.
 *
 * CP is monotonically non-decreasing as level increases for a fixed IV
 * spread (CPM only grows with level), so a binary search over the level
 * table is valid and avoids scanning all 101 levels per IV combination.
 *
 * @param float[] $cpms Ascending CP multipliers, indexed 0..100.
 */
function find_max_level_index_under_cap(
    int $baseAtk,
    int $ivAtk,
    int $baseDef,
    int $ivDef,
    int $baseSta,
    int $ivSta,
    int $cpCap,
    array $cpms
): int {
    $lastValidIndex = -1;
    $low = 0;
    $high = count($cpms) - 1;

    while ($low <= $high) {
        $mid = intdiv($low + $high, 2);
        $cp = calculate_cp($baseAtk, $ivAtk, $baseDef, $ivDef, $baseSta, $ivSta, $cpms[$mid]);

        if ($cp <= $cpCap) {
            $lastValidIndex = $mid;
            $low = $mid + 1;
        } else {
            $high = $mid - 1;
        }
    }

    return $lastValidIndex;
}

/**
 * Finds the #1 ranked PvP IV build (highest Stat Product) for a species
 * under a given CP cap, scanning all 4096 IV combinations (0-15 per stat).
 *
 * Stat Product = Attack stat * Defense stat * floor(HP stat), matching the
 * convention used by the PvPoke ranking methodology (HP is floored because
 * it is displayed/used as a whole number in-game; Attack/Defense are not).
 *
 * @param string[] $levelLabels Level labels ("1.0".."51.0"), ascending, index-aligned with $cpms.
 * @param float[] $cpms CP multipliers, ascending, index-aligned with $levelLabels.
 * @return array<string,mixed>|null Null when no IV combination fits under the cap.
 */
function find_optimal_pvp_build(
    int $baseAtk,
    int $baseDef,
    int $baseSta,
    int $cpCap,
    array $levelLabels,
    array $cpms
): ?array {
    $best = null;

    for ($ivAtk = 0; $ivAtk <= 15; $ivAtk++) {
        for ($ivDef = 0; $ivDef <= 15; $ivDef++) {
            for ($ivSta = 0; $ivSta <= 15; $ivSta++) {
                $levelIndex = find_max_level_index_under_cap(
                    $baseAtk, $ivAtk, $baseDef, $ivDef, $baseSta, $ivSta, $cpCap, $cpms
                );

                if ($levelIndex === -1) {
                    continue; // Even level 1 with these IVs exceeds the cap.
                }

                $cpm = $cpms[$levelIndex];
                $statAtk = ($baseAtk + $ivAtk) * $cpm;
                $statDef = ($baseDef + $ivDef) * $cpm;
                $statHp = floor(($baseSta + $ivSta) * $cpm);
                $statProduct = $statAtk * $statDef * $statHp;

                if ($best === null || $statProduct > $best['statProduct']) {
                    $best = [
                        'ivAtk' => $ivAtk,
                        'ivDef' => $ivDef,
                        'ivSta' => $ivSta,
                        'level' => $levelLabels[$levelIndex],
                        'cp' => calculate_cp($baseAtk, $ivAtk, $baseDef, $ivDef, $baseSta, $ivSta, $cpm),
                        'statProduct' => (int) round($statProduct),
                    ];
                }
            }
        }
    }

    return $best;
}

/**
 * Builds the Master League entry: always 15/15/15 at the highest available
 * level, since there is no CP cap to optimize against.
 *
 * @param array<string,float> $cpMultipliers
 */
function build_master_league_entry(int $baseAtk, int $baseDef, int $baseSta, array $cpMultipliers): array
{
    $topLevel = '51.0';
    $cpm = $cpMultipliers[$topLevel];

    $statAtk = ($baseAtk + 15) * $cpm;
    $statDef = ($baseDef + 15) * $cpm;
    $statHp = floor(($baseSta + 15) * $cpm);

    return [
        'eligible' => true,
        'ivAtk' => 15,
        'ivDef' => 15,
        'ivSta' => 15,
        'level' => $topLevel,
        'cp' => calculate_cp($baseAtk, 15, $baseDef, 15, $baseSta, 15, $cpm),
        'statProduct' => (int) round($statAtk * $statDef * $statHp),
    ];
}

/**
 * Computes the optimal build for every league defined in data.json for one
 * species' base stats.
 *
 * @param array<string,mixed> $leagues
 * @param array<string,float> $cpMultipliers
 * @return array<string,array<string,mixed>>
 */
function compute_all_leagues(
    string $memberSlug,
    int $baseAtk,
    int $baseDef,
    int $baseSta,
    array $leagues,
    array $cpMultipliers
): array {
    $levelLabels = array_keys($cpMultipliers);
    $cpms = array_values($cpMultipliers);

    $result = [];

    foreach ($leagues as $leagueId => $league) {
        if ($league['cpCap'] === null) {
            $entry = build_master_league_entry($baseAtk, $baseDef, $baseSta, $cpMultipliers);
        } else {
            $build = find_optimal_pvp_build($baseAtk, $baseDef, $baseSta, (int) $league['cpCap'], $levelLabels, $cpms);

            $entry = $build === null
                ? [
                    'eligible' => false,
                    'reason' => "Base stats are too high to fit under the {$league['cpCap']} CP cap even at 0/0/0, level 1.",
                ]
                : array_merge(['eligible' => true], $build);
        }

        // "ranking" is the community battle-simulation rank/score/moveset
        // for this species in this league, sourced from the PvPoke-style
        // CSV in /rankings/ (null if the species isn't present in that
        // export - e.g. it was judged too weak to be worth ranking).
        $entry['ranking'] = lookup_league_ranking($memberSlug, $league);

        $result[$leagueId] = $entry;
    }

    return $result;
}

// ---------------------------------------------------------------------------
// Community PvP ranking lookup (PvPoke-style CSV exports)
// ---------------------------------------------------------------------------

/**
 * Parses a PvPoke-style ranking export CSV (Pokemon, Score, ..., Fast Move,
 * Charged Move 1, Charged Move 2, ...) into a slug-keyed lookup table.
 *
 * These CSVs encode a full battle-simulation ranking (each Pokemon's score
 * is derived from simulated matchups, with shields, against the rest of the
 * league's viable meta) that this app does not attempt to reproduce - that
 * would mean re-implementing PvPoke's entire battle simulator. Instead we
 * read PvPoke's own exported rankings directly. Drop a freshly exported CSV
 * from https://pvpoke.com/rankings/ over the matching file in /rankings/
 * (same filename) to refresh the data; no code changes required.
 *
 * Parsed results are cached per file path for the lifetime of the request.
 *
 * @return array{bySlug: array<string,array<string,mixed>>, totalRanked: int}
 */
function load_ranking_csv(string $relativePath): array
{
    static $cache = [];

    if (isset($cache[$relativePath])) {
        return $cache[$relativePath];
    }

    $bySlug = [];
    $rank = 0;
    $path = __DIR__ . '/' . $relativePath;
    $handle = @fopen($path, 'r');

    if ($handle !== false) {
        $header = fgetcsv($handle);
        $columns = is_array($header) ? array_flip($header) : [];

        while (($row = fgetcsv($handle)) !== false) {
            $nameIndex = $columns['Pokemon'] ?? null;

            if ($nameIndex === null || !isset($row[$nameIndex]) || $row[$nameIndex] === '') {
                continue; // Skip blank/malformed lines rather than let them corrupt ranks.
            }

            $rank++;
            $name = $row[$nameIndex];
            $slug = normalize_ranking_pokemon_name($name);

            $entry = [
                'rank' => $rank,
                'name' => $name,
                'score' => isset($columns['Score'], $row[$columns['Score']]) ? (float) $row[$columns['Score']] : null,
                'statProduct' => isset($columns['Stat Product'], $row[$columns['Stat Product']]) ? (int) $row[$columns['Stat Product']] : null,
                'level' => isset($columns['Level'], $row[$columns['Level']]) ? $row[$columns['Level']] : null,
                'cp' => isset($columns['CP'], $row[$columns['CP']]) ? (int) $row[$columns['CP']] : null,
                'fastMove' => isset($columns['Fast Move'], $row[$columns['Fast Move']]) ? clean_move_name($row[$columns['Fast Move']]) : null,
                'chargedMove1' => isset($columns['Charged Move 1'], $row[$columns['Charged Move 1']]) ? clean_move_name($row[$columns['Charged Move 1']]) : null,
                'chargedMove2' => isset($columns['Charged Move 2'], $row[$columns['Charged Move 2']]) ? clean_move_name($row[$columns['Charged Move 2']]) : null,
            ];

            // Same base species can appear more than once if the export
            // includes alternate forms (e.g. "Zacian (Crowned Sword)"),
            // which normalize to the same slug as the base form. Keep only
            // the first (best-ranked) occurrence.
            if (!isset($bySlug[$slug])) {
                $bySlug[$slug] = $entry;
            }
        }

        fclose($handle);
    }

    $result = ['bySlug' => $bySlug, 'totalRanked' => $rank];
    $cache[$relativePath] = $result;

    return $result;
}

/**
 * Normalizes a ranking CSV "Pokemon" column value (which may include a
 * parenthetical form suffix, e.g. "Zacian (Crowned Sword)") down to the
 * same slug format used for baseStats keys, so the two datasets can be
 * matched against each other.
 */
function normalize_ranking_pokemon_name(string $name): string
{
    $withoutForm = preg_replace('/\s*\(.*?\)\s*/', '', $name);

    return normalize_species_slug((string) $withoutForm) ?? '';
}

/**
 * Strips PvPoke's HTML footnote markup from move names (e.g. the
 * "<sup>&dagger;</sup>" legacy-move marker), leaving the plain-text
 * legacy (dagger) / Elite-TM (asterisk) annotations PvPoke also uses
 * inline in the move name itself.
 */
function clean_move_name(string $rawMoveName): string
{
    $decoded = html_entity_decode($rawMoveName, ENT_QUOTES | ENT_HTML5);

    return trim(strip_tags($decoded));
}

/**
 * Looks up a species' community PvP ranking entry for one league, if the
 * league has a ranking file and the species appears in it.
 *
 * @param array<string,mixed> $league
 * @return array<string,mixed>|null
 */
function lookup_league_ranking(string $memberSlug, array $league): ?array
{
    if (!isset($league['rankingFile'])) {
        return null;
    }

    $csv = load_ranking_csv((string) $league['rankingFile']);
    $entry = $csv['bySlug'][$memberSlug] ?? null;

    if ($entry === null) {
        return null;
    }

    return array_merge($entry, ['totalRanked' => $csv['totalRanked']]);
}

// ---------------------------------------------------------------------------
// AJAX endpoint
// ---------------------------------------------------------------------------

function handle_search_request(): void
{
    header('Content-Type: application/json; charset=utf-8');

    $gameData = load_game_data();
    $rawQuery = isset($_GET['pokemon']) ? (string) $_GET['pokemon'] : '';
    $slug = normalize_species_slug($rawQuery);

    if ($slug === null) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Please enter a Pokemon name to search.']);
        return;
    }

    $family = resolve_evolution_family($slug, $gameData);

    if ($family === null) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => "Couldn't find a Pokemon named \"{$rawQuery}\". Check the spelling and try again.",
        ]);
        return;
    }

    $baseStats = $gameData['baseStats'];
    $leagues = $gameData['leagues'];
    $cpMultipliers = $gameData['cpMultipliers'];

    $members = [];
    foreach ($family['names'] as $memberSlug) {
        if (!isset($baseStats[$memberSlug])) {
            // We don't have GO base stats hardcoded for this family member yet;
            // skip it rather than showing incomplete/incorrect data.
            continue;
        }

        $stats = $baseStats[$memberSlug];

        $members[] = [
            'slug' => $memberSlug,
            'dex' => $stats['dex'],
            'displayName' => $stats['displayName'],
            'types' => $stats['types'],
            'baseStats' => [
                'attack' => $stats['attack'],
                'defense' => $stats['defense'],
                'stamina' => $stats['stamina'],
            ],
            'raid' => $stats['raid'],
            // Little Cup traditionally only permits Pokemon that can still evolve further.
            'littleCupEligible' => $family['hasNextEvolution'][$memberSlug] ?? false,
            'leagues' => compute_all_leagues(
                $memberSlug,
                (int) $stats['attack'],
                (int) $stats['defense'],
                (int) $stats['stamina'],
                $leagues,
                $cpMultipliers
            ),
        ];
    }

    if (empty($members) || !in_array($slug, array_column($members, 'slug'), true)) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => "\"{$rawQuery}\" was recognized, but this demo dataset doesn't include GO base stats for it or its family yet. "
                . 'Try: bulbasaur, charmander, squirtle, pikachu, eevee, dratini, magikarp, or mewtwo.',
        ]);
        return;
    }

    echo json_encode([
        'success' => true,
        'query' => $rawQuery,
        'resolvedSlug' => $slug,
        'dataSource' => $family['source'],
        'leagueDefinitions' => $leagues,
        'family' => $members,
    ]);
}

// ---------------------------------------------------------------------------
// Entry point: dispatch AJAX requests, otherwise fall through to the HTML page.
// ---------------------------------------------------------------------------

if (isset($_GET['action']) && $_GET['action'] === 'search') {
    handle_search_request();
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pokecheck &mdash; Pokemon GO PvP Reference</title>
<style>
  :root {
    --bg: #0f172a;
    --panel: #16213a;
    --panel-alt: #1c2b4a;
    --border: #2c3e63;
    --text: #eef2ff;
    --text-dim: #9aa7c7;
    --accent: #ffcb05;
    --accent-dark: #cc9f00;
    --blue: #3b6bd6;
    --good: #37c07c;
    --bad: #e5534b;
    --radius: 10px;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, var(--bg), #0a1122 60%);
    color: var(--text);
    min-height: 100vh;
  }

  header {
    text-align: center;
    padding: 2.5rem 1rem 1.5rem;
  }

  header h1 {
    margin: 0 0 0.35rem;
    font-size: 2rem;
    letter-spacing: 0.02em;
  }

  header h1 span { color: var(--accent); }

  header p {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.95rem;
  }

  main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 0 1rem 3rem;
  }

  .search-panel {
    display: flex;
    gap: 0.6rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem;
    flex-wrap: wrap;
  }

  #pokemon-input {
    flex: 1 1 220px;
    min-width: 0;
    padding: 0.7rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: #0c1730;
    color: var(--text);
    font-size: 1rem;
  }

  #pokemon-input:focus {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  #search-btn {
    padding: 0.7rem 1.4rem;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: #1a1a1a;
    font-weight: 700;
    font-size: 1rem;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  #search-btn:hover { background: var(--accent-dark); }
  #search-btn:disabled { opacity: 0.6; cursor: default; }

  .quick-picks {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
    color: var(--text-dim);
  }

  .quick-picks button {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 999px;
    padding: 0.2rem 0.7rem;
    margin: 0.15rem 0.2rem;
    cursor: pointer;
    font-size: 0.8rem;
  }

  .quick-picks button:hover { border-color: var(--accent); color: var(--accent); }

  #status-area {
    margin-top: 1.25rem;
    min-height: 1.5rem;
  }

  .message {
    padding: 0.8rem 1rem;
    border-radius: var(--radius);
    font-size: 0.95rem;
  }

  .message.error { background: rgba(229, 83, 75, 0.15); border: 1px solid var(--bad); color: #ffd3d0; }
  .message.info { color: var(--text-dim); }

  #results {
    margin-top: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .pokemon-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem 1.3rem;
  }

  .pokemon-card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.7rem;
    margin-bottom: 0.9rem;
  }

  .pokemon-card-head h2 {
    margin: 0;
    font-size: 1.3rem;
  }

  .pokemon-card-head .dex {
    color: var(--text-dim);
    font-weight: 400;
    font-size: 0.9rem;
    margin-right: 0.4rem;
  }

  .type-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
    background: var(--blue);
    color: #fff;
    margin-left: 0.3rem;
  }

  .raid-line {
    font-size: 0.85rem;
    color: var(--text-dim);
    margin: 0 0 0.9rem;
    line-height: 1.4;
  }

  .raid-badges { margin-bottom: 0.4rem; }

  .badge {
    display: inline-block;
    font-size: 0.72rem;
    font-weight: 700;
    padding: 0.15rem 0.55rem;
    border-radius: 6px;
    margin-right: 0.35rem;
    letter-spacing: 0.02em;
  }

  .badge.tier { background: var(--accent); color: #1a1a1a; }
  .badge.attacker { background: var(--good); color: #06301c; }
  .badge.defender { background: var(--blue); color: #fff; }
  .badge.lc { background: var(--panel-alt); color: var(--text-dim); border: 1px solid var(--border); }

  .table-scroll {
    overflow-x: auto;
  }

  table.league-table {
    width: 100%;
    min-width: 560px;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  table.league-table th,
  table.league-table td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--border);
  }

  table.league-table th {
    color: var(--text-dim);
    font-weight: 600;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  table.league-table td.not-eligible {
    color: var(--bad);
    font-style: italic;
  }

  .iv-set { font-variant-numeric: tabular-nums; }

  .unranked {
    color: var(--text-dim);
    font-style: italic;
  }

  footer {
    text-align: center;
    color: var(--text-dim);
    font-size: 0.78rem;
    padding: 1rem 1.5rem 2rem;
  }

  footer p {
    max-width: 640px;
    margin: 0.25rem auto;
    line-height: 1.5;
  }

  footer code {
    background: var(--panel-alt);
    border-radius: 4px;
    padding: 0.05rem 0.35rem;
  }

  @media (max-width: 560px) {
    table.league-table { font-size: 0.8rem; }
    table.league-table th, table.league-table td { padding: 0.4rem 0.35rem; }
  }
</style>
</head>
<body>

<header>
  <h1>Pokecheck<span>.</span> PvP Reference</h1>
  <p>Search a Pokemon to see PvP-optimal IVs for its whole evolution family.</p>
</header>

<main>
  <div class="search-panel">
    <input type="text" id="pokemon-input" placeholder="Search a Pokemon (e.g. Squirtle)" autocomplete="off">
    <button id="search-btn" type="button">Search</button>
  </div>
  <div class="quick-picks">
    Try:
    <button type="button" class="quick-pick-btn" data-name="bulbasaur">Bulbasaur</button>
    <button type="button" class="quick-pick-btn" data-name="squirtle">Squirtle</button>
    <button type="button" class="quick-pick-btn" data-name="charmander">Charmander</button>
    <button type="button" class="quick-pick-btn" data-name="eevee">Eevee</button>
    <button type="button" class="quick-pick-btn" data-name="dratini">Dratini</button>
    <button type="button" class="quick-pick-btn" data-name="mewtwo">Mewtwo</button>
  </div>

  <div id="status-area"></div>
  <div id="results"></div>
</main>

<footer>
  <p>Base stats sourced from the Pokemon GO game master (PvPoke methodology). Evolution family lookups via PokeAPI.</p>
  <p>PvPoke Rank / Top Moveset columns come from PvPoke's own exported battle-simulation rankings (<code>/rankings/*.csv</code>) &mdash; drop in a freshly exported CSV with the same filename to refresh them. <code>*</code> = Community Day / Elite TM move, <code>&dagger;</code> = legacy move no longer obtainable.</p>
</footer>

<script src="jquery.min.js"></script>
<script src="script.js"></script>
</body>
</html>
