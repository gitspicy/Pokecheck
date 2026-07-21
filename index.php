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
 * No database, no local write access, and no outbound network calls of any
 * kind are required - everything (CP multipliers, GO base stats, evolution
 * family data, league rules, and the community ranking CSVs) is static data
 * shipped in this repo (data.json + /rankings/*.csv). baseStats and each
 * species' evolution family both come directly from PvPoke's own public
 * gamemaster.json, so family lookups need no external API call.
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
 * Normalizes a raw search term (or a data.json displayName / speciesId) into
 * PvPoke's own gamemaster speciesId format (lowercase, underscore-separated,
 * alphanumeric only) so user input can be matched directly against
 * data.json's baseStats keys - e.g. "Mr. Mime", "mr-mime" and "mr_mime" all
 * normalize to "mr_mime".
 *
 * @return string|null Null when the input contains no usable characters.
 */
function normalize_species_slug(string $raw): ?string
{
    $trimmed = trim($raw);

    if ($trimmed === '' || mb_strlen($trimmed) > 60) {
        return null;
    }

    $lower = mb_strtolower($trimmed);
    $lower = str_replace(['♀', '♂'], [' female', ' male'], $lower);
    // Apostrophes/periods are dropped outright (matches PvPoke's own
    // "Farfetch'd" -> "farfetchd" convention), everything else non-alphanumeric
    // collapses to a single underscore.
    $slug = str_replace(["'", '.'], '', $lower);
    $slug = preg_replace('/[^a-z0-9]+/', '_', (string) $slug);
    $slug = trim((string) $slug, '_');

    return $slug === '' ? null : $slug;
}

// ---------------------------------------------------------------------------
// Evolution family resolution (fully local - driven by data.json's baseStats)
// ---------------------------------------------------------------------------

/**
 * Resolves a search slug to a baseStats key, trying a direct hit first and
 * then data.json's small table of known displayName-normalization
 * exceptions (species whose display name doesn't normalize back to its own
 * speciesId, e.g. "Zygarde (50% Forme)" -> "zygarde", not "zygarde_50_forme").
 */
function resolve_species_key(string $slug, array $gameData): ?string
{
    if (isset($gameData['baseStats'][$slug])) {
        return $slug;
    }

    $alias = $gameData['displayNameAliases'][$slug] ?? null;

    return isset($gameData['baseStats'][$alias]) ? $alias : null;
}

/**
 * Resolves the full evolution family for a species key, purely from the
 * "family" block each baseStats entry carries (itself imported straight
 * from PvPoke's gamemaster.json - see data.json's top-level comment).
 *
 * Family members with no "family" block at all (e.g. Mewtwo) are treated
 * as a family of one. Traversal starts at the root (the member with no
 * "parent", or whose parent isn't in baseStats) and walks "evolutions"
 * breadth-first, so branching families (Eevee) come back in a sensible
 * base-first order.
 *
 * @param array<string,mixed> $baseStats
 * @return array{names: string[], canEvolveFurther: array<string,bool>}
 */
function resolve_evolution_family(string $speciesKey, array $baseStats): array
{
    $family = $baseStats[$speciesKey]['family'] ?? null;

    if ($family === null) {
        return [
            'names' => [$speciesKey],
            'canEvolveFurther' => [$speciesKey => false],
        ];
    }

    $familyId = $family['id'];
    $members = [];
    foreach ($baseStats as $key => $entry) {
        if (($entry['family']['id'] ?? null) === $familyId) {
            $members[$key] = $entry['family'];
        }
    }

    $root = $speciesKey;
    foreach ($members as $key => $familyData) {
        if (!isset($familyData['parent'])) {
            $root = $key;
            break;
        }
    }

    $orderedNames = [];
    $canEvolveFurther = [];
    $queue = [$root];

    while ($queue !== []) {
        $current = array_shift($queue);

        if (!isset($members[$current]) || in_array($current, $orderedNames, true)) {
            continue;
        }

        $orderedNames[] = $current;
        $evolutions = $members[$current]['evolutions'] ?? [];
        $canEvolveFurther[$current] = $evolutions !== [];

        foreach ($evolutions as $next) {
            $queue[] = $next;
        }
    }

    return ['names' => $orderedNames, 'canEvolveFurther' => $canEvolveFurther];
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
// Raid attacker DPS / type-attacker / tier-list lookup
// ---------------------------------------------------------------------------

/**
 * Parses the global raid-attacker DPS ranking CSV (Rank, Pokemon, Dex,
 * Type1, Type2, Fast/Charged Move (+Type), DPS, TDO, ER, CP, Shadow, Mega).
 *
 * Returns both the full ordered row list (needed to re-derive a per-type
 * ranking by filtering on Type1/Type2) and a slug-keyed lookup for direct
 * "find this species' row" access.
 *
 * @return array{rows: array<int,array<string,mixed>>, bySlug: array<string,int>}
 */
function load_attacker_dps_csv(string $relativePath): array
{
    static $cache = [];

    if (isset($cache[$relativePath])) {
        return $cache[$relativePath];
    }

    $rows = [];
    $bySlug = [];
    $path = __DIR__ . '/' . $relativePath;
    $handle = @fopen($path, 'r');

    if ($handle !== false) {
        $header = fgetcsv($handle);
        $columns = is_array($header) ? array_flip($header) : [];

        while (($row = fgetcsv($handle)) !== false) {
            $nameIndex = $columns['Pokemon'] ?? null;

            if ($nameIndex === null || !isset($row[$nameIndex]) || $row[$nameIndex] === '') {
                continue;
            }

            $name = $row[$nameIndex];
            $slug = normalize_ranking_pokemon_name($name);

            $rowIndex = count($rows);
            $rows[] = [
                'rank' => $rowIndex + 1,
                'name' => $name,
                'type1' => isset($columns['Type1'], $row[$columns['Type1']]) ? strtolower($row[$columns['Type1']]) : '',
                'type2' => isset($columns['Type2'], $row[$columns['Type2']]) ? strtolower($row[$columns['Type2']]) : '',
                'fastMove' => isset($columns['Fast Move'], $row[$columns['Fast Move']]) ? clean_move_name($row[$columns['Fast Move']]) : null,
                'chargedMove' => isset($columns['Charged Move'], $row[$columns['Charged Move']]) ? clean_move_name($row[$columns['Charged Move']]) : null,
                'dps' => isset($columns['DPS'], $row[$columns['DPS']]) ? (float) $row[$columns['DPS']] : null,
                'tdo' => isset($columns['TDO'], $row[$columns['TDO']]) ? (int) $row[$columns['TDO']] : null,
                'er' => isset($columns['ER'], $row[$columns['ER']]) ? (float) $row[$columns['ER']] : null,
                'cp' => isset($columns['CP'], $row[$columns['CP']]) ? (int) $row[$columns['CP']] : null,
                'isShadow' => isset($columns['Shadow'], $row[$columns['Shadow']]) && strtolower((string) $row[$columns['Shadow']]) === 'true',
                'isMega' => isset($columns['Mega'], $row[$columns['Mega']]) && strtolower((string) $row[$columns['Mega']]) === 'true',
            ];

            // Prefer the first (highest-DPS, since the file is DPS-sorted)
            // occurrence of a slug, e.g. plain "Venusaur" over a duplicate.
            if (!isset($bySlug[$slug])) {
                $bySlug[$slug] = $rowIndex;
            }
        }

        fclose($handle);
    }

    $result = ['rows' => $rows, 'bySlug' => $bySlug];
    $cache[$relativePath] = $result;

    return $result;
}

/**
 * Parses the community attacker tier-list CSV (Rank, Tier, Pokemon,
 * Type1, Type2) into a slug-keyed lookup.
 *
 * @return array<string,array{tier:string, rank:int}>
 */
function load_attacker_tier_csv(string $relativePath): array
{
    static $cache = [];

    if (isset($cache[$relativePath])) {
        return $cache[$relativePath];
    }

    $bySlug = [];
    $path = __DIR__ . '/' . $relativePath;
    $handle = @fopen($path, 'r');

    if ($handle !== false) {
        $header = fgetcsv($handle);
        $columns = is_array($header) ? array_flip($header) : [];
        $rank = 0;

        while (($row = fgetcsv($handle)) !== false) {
            $nameIndex = $columns['Pokemon'] ?? null;

            if ($nameIndex === null || !isset($row[$nameIndex]) || $row[$nameIndex] === '') {
                continue;
            }

            $rank++;
            $slug = normalize_ranking_pokemon_name($row[$nameIndex]);

            if (!isset($bySlug[$slug])) {
                $bySlug[$slug] = [
                    'tier' => isset($columns['Tier'], $row[$columns['Tier']]) ? $row[$columns['Tier']] : '',
                    'rank' => $rank,
                ];
            }
        }

        fclose($handle);
    }

    $cache[$relativePath] = $bySlug;

    return $bySlug;
}

/**
 * Builds the raid-attacker summary for one species: its overall DPS rank,
 * DPS/TDO/ER stats and recommended raid moveset, its rank within each of
 * its own types' attacker pool (e.g. "top 10 Fairy attackers"), and its
 * community tier-list placement.
 *
 * @param array<string,mixed> $attackerRankings data.json's "attackerRankings" block
 * @param string[] $types This species' types, e.g. ["water", "flying"]
 * @return array<string,mixed>|null Null if the species isn't in the DPS dataset at all.
 */
function build_attacker_summary(string $memberSlug, array $types, array $attackerRankings): ?array
{
    $dps = load_attacker_dps_csv((string) $attackerRankings['dpsFile']);
    $rowIndex = $dps['bySlug'][$memberSlug] ?? null;

    if ($rowIndex === null) {
        return null;
    }

    $row = $dps['rows'][$rowIndex];

    $byType = [];
    foreach ($types as $type) {
        $type = strtolower($type);
        $matching = array_values(array_filter(
            $dps['rows'],
            static fn (array $r): bool => $r['type1'] === $type || $r['type2'] === $type
        ));

        $positionInType = null;
        foreach ($matching as $i => $r) {
            if ($r['name'] === $row['name']) {
                $positionInType = $i + 1;
                break;
            }
        }

        $byType[$type] = [
            'rank' => $positionInType,
            'total' => count($matching),
            'isTop10' => $positionInType !== null && $positionInType <= 10,
        ];
    }

    $tierData = load_attacker_tier_csv((string) $attackerRankings['tierFile']);
    $tier = $tierData[$memberSlug] ?? null;

    return [
        'name' => $row['name'],
        'overallRank' => $row['rank'],
        'totalOverall' => count($dps['rows']),
        'dps' => $row['dps'],
        'tdo' => $row['tdo'],
        'er' => $row['er'],
        'cp' => $row['cp'],
        'fastMove' => $row['fastMove'],
        'chargedMove' => $row['chargedMove'],
        'isShadow' => $row['isShadow'],
        'isMega' => $row['isMega'],
        'byType' => $byType,
        'tier' => $tier === null ? null : ['label' => $tier['tier'], 'rank' => $tier['rank']],
    ];
}

// ---------------------------------------------------------------------------
// AJAX endpoint
// ---------------------------------------------------------------------------

function handle_search_request(): void
{
    header('Content-Type: application/json; charset=utf-8');

    // This endpoint must always emit a single valid JSON body. A stray
    // PHP warning/notice printed to output (e.g. from a misconfigured
    // extension) would otherwise land in front of the JSON and break
    // jQuery's dataType:'json' parsing - which surfaces to the user as a
    // generic "could not reach the server" with no clue what actually
    // happened. Errors are logged server-side instead of displayed, and
    // any exception is caught and turned into a proper JSON error body.
    ini_set('display_errors', '0');

    try {
        handle_search_request_body();
    } catch (\Throwable $e) {
        error_log('Pokecheck search failed: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Something went wrong while looking that up. Please try again.',
        ]);
    }
}

function handle_search_request_body(): void
{
    $gameData = load_game_data();
    $rawQuery = isset($_GET['pokemon']) ? (string) $_GET['pokemon'] : '';
    $slug = normalize_species_slug($rawQuery);

    if ($slug === null) {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'Please enter a Pokemon name to search.']);
        return;
    }

    $baseStats = $gameData['baseStats'];
    $speciesKey = resolve_species_key($slug, $gameData);

    if ($speciesKey === null) {
        http_response_code(404);
        echo json_encode([
            'success' => false,
            'error' => "Couldn't find a Pokemon named \"{$rawQuery}\". Check the spelling and try again.",
        ]);
        return;
    }

    $family = resolve_evolution_family($speciesKey, $baseStats);
    $leagues = $gameData['leagues'];
    $cpMultipliers = $gameData['cpMultipliers'];
    $attackerRankings = $gameData['attackerRankings'];

    $members = [];
    foreach ($family['names'] as $memberSlug) {
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
            'attacker' => build_attacker_summary($memberSlug, $stats['types'], $attackerRankings),
            // Little Cup traditionally only permits Pokemon that can still evolve further.
            'littleCupEligible' => $family['canEvolveFurther'][$memberSlug] ?? false,
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

    $payload = json_encode([
        'success' => true,
        'query' => $rawQuery,
        'resolvedSlug' => $speciesKey,
        'leagueDefinitions' => $leagues,
        'family' => $members,
    ]);

    if ($payload === false) {
        // json_encode() only fails on malformed input (e.g. invalid UTF-8
        // slipping in from an external source); never emit an empty body.
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Something went wrong building the response. Please try again.',
        ]);
        return;
    }

    echo $payload;
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

  .section-heading {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin: 1.1rem 0 0.5rem;
  }

  .attacker-panel {
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
  }

  .attacker-panel .raid-line { margin-bottom: 0.5rem; }
  .attacker-panel .raid-line:last-child { margin-bottom: 0; }

  .attacker-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    margin-bottom: 0.6rem;
  }

  .attacker-stat {
    display: flex;
    flex-direction: column;
    font-size: 0.9rem;
  }

  .attacker-stat span {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-dim);
  }

  .type-attacker-list {
    list-style: none;
    margin: 0 0 0.6rem;
    padding: 0;
    font-size: 0.88rem;
  }

  .type-attacker-list li {
    padding: 0.25rem 0;
    border-bottom: 1px dashed var(--border);
  }

  .type-attacker-list li:last-child { border-bottom: none; }

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
    <button type="button" class="quick-pick-btn" data-name="tadbulb">Tadbulb</button>
  </div>

  <div id="status-area"></div>
  <div id="results"></div>
</main>

<footer>
  <p>Base stats and evolution family data are imported directly from PvPoke's public gamemaster.json (1,045 released species/forms) &mdash; no external API calls at runtime.</p>
  <p>PvPoke Rank / Top Moveset columns come from PvPoke's own exported battle-simulation rankings (<code>/rankings/*.csv</code>) &mdash; drop in a freshly exported CSV with the same filename to refresh them. <code>*</code> = Community Day / Elite TM move, <code>&dagger;</code> = legacy move no longer obtainable.</p>
</footer>

<script src="jquery.min.js"></script>
<script src="script.js"></script>
</body>
</html>
