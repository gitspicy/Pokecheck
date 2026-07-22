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
// Species artwork (local WebP files, resized from HybridShivam/Pokemon's
// official Sugimori artwork mirror - see /images/README.md)
// ---------------------------------------------------------------------------

/**
 * Returns the site-relative path to a species' local artwork file for the
 * given variant ("hero" ~260px for card headers, "icon" ~56px for the
 * autocomplete dropdown and family strip), or null if no file was
 * generated for that slug (e.g. a future baseStats addition the image
 * pipeline hasn't been re-run for yet) - callers must handle a missing
 * image gracefully rather than assume every species has one.
 */
function resolve_image_path(string $slug, string $variant): ?string
{
    static $exists = [];

    $relative = "images/{$variant}/{$slug}.webp";
    $key = $variant . '/' . $slug;

    if (!isset($exists[$key])) {
        $exists[$key] = is_file(__DIR__ . '/' . $relative);
    }

    return $exists[$key] ? $relative : null;
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
 * as a family of one. Traversal walks "evolutions" breadth-first from each
 * root (a member with no "parent") so branching families (Eevee) come back
 * in a sensible base-first order.
 *
 * A family can have MORE THAN ONE root: regional forms (Alolan/Galarian/
 * Hisuian/Paldean) share their standard form's family id in PvPoke's data,
 * but aren't "evolved from" it - Galarian Ponyta has no "parent", same as
 * Ponyta itself, so FAMILY_PONYTA has two disconnected roots (Ponyta and
 * Ponyta (Galarian)) each with their own evolution line. Seeding the BFS
 * from every rootless member, not just the first one found, is what makes
 * a search for "ponyta" also return the Galarian line instead of silently
 * dropping it.
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
            'stage' => [$speciesKey => 0],
        ];
    }

    $familyId = $family['id'];
    $members = [];
    foreach ($baseStats as $key => $entry) {
        if (($entry['family']['id'] ?? null) === $familyId) {
            $members[$key] = $entry['family'];
        }
    }

    $roots = [];
    foreach ($members as $key => $familyData) {
        if (!isset($familyData['parent'])) {
            $roots[] = $key;
        }
    }

    if ($roots === []) {
        $roots = [$speciesKey];
    }

    $orderedNames = [];
    $canEvolveFurther = [];
    $stage = [];
    // Queue holds [speciesKey, depth] pairs so branching families (Eevee,
    // or a regional form's own sub-branch) report which "evolution stage"
    // each member belongs to - the front end groups same-stage siblings
    // together instead of drawing a misleading linear chain through them.
    // Every root starts its own line at depth 0.
    $queue = [];
    foreach ($roots as $root) {
        $queue[] = [$root, 0];
    }

    while ($queue !== []) {
        [$current, $depth] = array_shift($queue);

        if (!isset($members[$current]) || in_array($current, $orderedNames, true)) {
            continue;
        }

        $orderedNames[] = $current;
        $stage[$current] = $depth;
        $evolutions = $members[$current]['evolutions'] ?? [];
        $canEvolveFurther[$current] = $evolutions !== [];

        foreach ($evolutions as $next) {
            $queue[] = [$next, $depth + 1];
        }
    }

    return ['names' => $orderedNames, 'canEvolveFurther' => $canEvolveFurther, 'stage' => $stage];
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
        // Shadow Pokemon get the same optimal CP/IV/level build as Normal
        // (Niantic's CP formula doesn't apply the Shadow attack/defense
        // multipliers - see data.json's shadowModifiers note), but their
        // battle-simulated rank/score/moveset genuinely differs, hence a
        // separate CSV lookup rather than reusing $entry['ranking'].
        $entry['shadowRanking'] = lookup_league_ranking($memberSlug . '_shadow', $league);

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
 * Known non-species "form tag" words that our CSV sources scatter through
 * Pokemon names in inconsistent positions and conventions - prefix
 * ("Alolan Diglett", "Shadow Mewtwo"), suffix ("Diglett (Alolan)",
 * "Altaria (Shadow)"), or combined/reordered ("Ninetales (Alolan)
 * (Shadow)", "Shadow Alolan Golem"). Region tags are also encoded
 * (in some order) inside our baseStats keys themselves (e.g.
 * "golem_alolan", "darmanitan_galarian_standard").
 */
const RANKING_REGION_TAGS = ['alolan' => true, 'galarian' => true, 'hisuian' => true, 'paldean' => true];

/**
 * Words that mean "the default/no-special-form state" and get included
 * inconsistently across our CSV sources - e.g. the DPS rankings call the
 * base form just "Darmanitan"/"Galarian Darmanitan", while baseStats (and
 * the tier list) spell it "darmanitan_standard"/"Darmanitan Standard".
 * Dropped from both sides during canonicalization rather than treated as
 * meaningful "base name" words, so the two sources still match. Safe only
 * because no two distinct baseStats entries differ solely by one of these
 * words (verified against the current roster).
 */
const RANKING_DISCARD_TOKENS = ['standard' => true];

/**
 * Splits a ranking CSV "Pokemon" column value into lowercase word tokens,
 * treating parentheses/hyphens/apostrophes/periods as plain separators
 * (so "Ninetales (Alolan)" and "Ho-Oh" tokenize the same way a baseStats
 * key's underscore-split would).
 *
 * @return string[]
 */
function tokenize_ranking_name(string $name): array
{
    $lower = mb_strtolower($name);
    $lower = str_replace(['♀', '♂'], [' female', ' male'], $lower);
    $clean = str_replace(["'", '.', '(', ')', '-'], ' ', $lower);
    $clean = (string) preg_replace('/[^a-z0-9]+/', ' ', $clean);

    return array_values(array_filter(explode(' ', trim($clean)), static function (string $t): bool {
        return $t !== '';
    }));
}

/**
 * Builds an order-independent signature from a token list: region-tag
 * words are pulled out and sorted separately from the remaining "base
 * name" words, so e.g. tokens from "Galarian Darmanitan Standard" and
 * from baseStats key "darmanitan_galarian_standard" (word order differs
 * between our two data sources) produce the identical signature.
 */
function canonicalize_species_tokens(array $tokens): string
{
    $base = [];
    $tags = [];

    foreach ($tokens as $t) {
        $t = strtolower((string) $t);
        if ($t === '' || isset(RANKING_DISCARD_TOKENS[$t])) {
            continue;
        }
        if (isset(RANKING_REGION_TAGS[$t])) {
            $tags[] = $t;
        } else {
            $base[] = $t;
        }
    }

    sort($tags);

    return implode('_', $base) . '|' . implode(',', $tags);
}

/**
 * Maps every baseStats key's canonical signature back to that key, so a
 * ranking CSV name can be resolved to the exact slug our roster uses
 * regardless of which of our sources' differing name conventions/word
 * orders produced it. Built once per request from load_game_data(), which
 * is itself already cached.
 *
 * @return array<string,string>
 */
function get_canonical_species_index(): array
{
    static $index = null;

    if ($index !== null) {
        return $index;
    }

    $index = [];
    foreach (load_game_data()['baseStats'] as $key => $entry) {
        $canonical = canonicalize_species_tokens(explode('_', $key));
        if (!isset($index[$canonical])) {
            $index[$canonical] = $key;
        }
    }

    return $index;
}

/**
 * Normalizes a ranking CSV "Pokemon" column value down to the exact
 * baseStats slug it refers to, so the two datasets can be matched against
 * each other regardless of naming convention differences between our
 * sources (parenthetical vs prefix form tags, differing word order for
 * compound forms, etc.) - see tokenize_ranking_name()/
 * canonicalize_species_tokens() above.
 *
 * Shadow is handled separately from region tags: it's stripped from the
 * token list before the canonical-index lookup (since Shadow forms are
 * never separate baseStats entries - see data.json's shadowModifiers
 * note) and re-appended as a "_shadow" suffix on whatever slug the
 * remaining (region-aware) tokens resolve to.
 */
function normalize_ranking_pokemon_name(string $name): string
{
    $tokens = tokenize_ranking_name($name);
    $isShadow = false;
    $remaining = [];

    foreach ($tokens as $t) {
        if ($t === 'shadow') {
            $isShadow = true;
        } else {
            $remaining[] = $t;
        }
    }

    $canonical = canonicalize_species_tokens($remaining);
    $index = get_canonical_species_index();
    // Fall back to a best-effort plain slug (won't match baseStats, but
    // keeps CSV rows for forms outside our roster from crashing anything).
    $slug = $index[$canonical] ?? implode('_', $remaining);

    return $isShadow && $slug !== '' ? $slug . '_shadow' : $slug;
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
    $shadowEligibleSpecies = array_flip($gameData['shadowEligibleSpecies']);

    $members = [];
    foreach ($family['names'] as $memberSlug) {
        $stats = $baseStats[$memberSlug];
        $isShadowEligible = isset($shadowEligibleSpecies[$memberSlug]);

        $members[] = [
            'slug' => $memberSlug,
            'dex' => $stats['dex'],
            'displayName' => $stats['displayName'],
            'types' => $stats['types'],
            'heroImage' => resolve_image_path($memberSlug, 'hero'),
            'iconImage' => resolve_image_path($memberSlug, 'icon'),
            'baseStats' => [
                'attack' => $stats['attack'],
                'defense' => $stats['defense'],
                'stamina' => $stats['stamina'],
            ],
            'attacker' => build_attacker_summary($memberSlug, $stats['types'], $attackerRankings),
            // Little Cup traditionally only permits Pokemon that can still evolve further.
            'littleCupEligible' => $family['canEvolveFurther'][$memberSlug] ?? false,
            'evolutionStage' => $family['stage'][$memberSlug] ?? 0,
            'leagues' => compute_all_leagues(
                $memberSlug,
                (int) $stats['attack'],
                (int) $stats['defense'],
                (int) $stats['stamina'],
                $leagues,
                $cpMultipliers
            ),
            // Shadow Pokemon: CP/IV/level optimal builds are identical to
            // Normal (see the shadowRanking comment in compute_all_leagues),
            // but raid-attacker DPS/rank differ, hence a separate lookup.
            'shadowEligible' => $isShadowEligible,
            'shadowAttacker' => $isShadowEligible
                ? build_attacker_summary($memberSlug . '_shadow', $stats['types'], $attackerRankings)
                : null,
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

/**
 * AJAX endpoint (?action=species-list): returns every searchable species
 * as {slug, label, dex, types}, fetched once by script.js on page load to
 * power client-side autocomplete - filtering ~1045 short records in the
 * browser is instant, so no per-keystroke request is needed.
 *
 * "label" disambiguates same-dex alternate forms (e.g. regional forms)
 * by appending "(Normal)" to whichever sibling's displayName doesn't
 * already carry a parenthetical qualifier, so typing "ponyta" surfaces
 * both "Ponyta (Normal)" and "Ponyta (Galarian)" as distinct choices.
 */
function handle_species_list_request(): void
{
    header('Content-Type: application/json; charset=utf-8');
    ini_set('display_errors', '0');

    try {
        $baseStats = load_game_data()['baseStats'];

        $byDex = [];
        foreach ($baseStats as $slug => $entry) {
            $byDex[$entry['dex']][] = $slug;
        }

        $list = [];
        foreach ($baseStats as $slug => $entry) {
            $label = $entry['displayName'];
            $isAmbiguous = count($byDex[$entry['dex']]) > 1;

            if ($isAmbiguous && strpos($label, '(') === false) {
                $label .= ' (Normal)';
            }

            $list[] = [
                'slug' => $slug,
                'label' => $label,
                'dex' => $entry['dex'],
                'types' => $entry['types'],
                'iconImage' => resolve_image_path($slug, 'icon'),
            ];
        }

        usort($list, static function (array $a, array $b): int {
            return $a['dex'] <=> $b['dex'] ?: strcmp($a['label'], $b['label']);
        });

        echo json_encode(['success' => true, 'species' => $list]);
    } catch (\Throwable $e) {
        error_log('Pokecheck species-list failed: ' . $e->getMessage());
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Could not load the species list.']);
    }
}

// ---------------------------------------------------------------------------
// Entry point: dispatch AJAX requests, otherwise fall through to the HTML page.
// ---------------------------------------------------------------------------

if (isset($_GET['action']) && $_GET['action'] === 'search') {
    handle_search_request();
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'species-list') {
    handle_species_list_request();
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pokecheck &mdash; Pokemon GO PvP Reference</title>
<link rel="icon" type="image/x-icon" href="images/brand/favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="images/brand/favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="images/brand/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="48x48" href="images/brand/favicon-48x48.png">
<link rel="apple-touch-icon" sizes="180x180" href="images/brand/apple-touch-icon.png">
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

  * {
    box-sizing: border-box;
    /* Kills the default gray flash Chrome/WebView draws on tap - a
       native-app APK wrapper should never show it. Buttons/links still
       get their own hover/active styles for feedback. */
    -webkit-tap-highlight-color: transparent;
  }

  html {
    /* Prevents the whole page from rubber-banding when a WebView wrapper
       has no browser chrome to absorb an overscroll drag. */
    overscroll-behavior-y: contain;
  }

  body {
    margin: 0;
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(180deg, var(--bg), #0a1122 60%);
    color: var(--text);
    min-height: 100vh;
  }

  button {
    /* Removes the ~300ms tap delay some WebViews still apply while
       waiting to see if a tap becomes a double-tap-to-zoom gesture. */
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
  }

  header {
    text-align: center;
    padding: 2.5rem 1rem 1.5rem;
  }

  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin-bottom: 0.35rem;
  }

  .brand-logo {
    display: block;
    width: 57px;
    height: 57px;
  }

  header h1 {
    margin: 0;
    font-size: 2.2rem;
    letter-spacing: 0.02em;
  }

  main {
    max-width: 1000px;
    margin: 0 auto;
    padding: 0 1rem 3rem;
  }

  .search-panel {
    position: relative;
    display: flex;
    gap: 0.6rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.9rem;
    flex-wrap: wrap;
  }

  .search-input-wrap {
    flex: 1 1 220px;
    min-width: 0;
  }

  #pokemon-input {
    width: 100%;
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

  .autocomplete-list {
    position: absolute;
    top: calc(100% + 0.4rem);
    left: 0;
    right: 0;
    z-index: 20;
    margin: 0;
    padding: 0.35rem;
    list-style: none;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
    max-height: 22rem;
    overflow-y: auto;
  }

  .autocomplete-list:empty { display: none; }

  .autocomplete-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border-radius: 7px;
    cursor: pointer;
    font-size: 0.92rem;
    touch-action: manipulation;
    -webkit-user-select: none;
    user-select: none;
  }

  .autocomplete-item:hover,
  .autocomplete-item.highlighted {
    background: var(--panel);
  }

  .ac-name-group {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .ac-icon {
    flex-shrink: 0;
    margin-right: 0.5rem;
    object-fit: contain;
  }

  .ac-icon-empty {
    display: inline-block;
    width: 28px;
    height: 28px;
    margin-right: 0.5rem;
    flex-shrink: 0;
  }

  .autocomplete-item .ac-dex {
    color: var(--text-dim);
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    margin-right: 0.5rem;
  }

  .autocomplete-item .ac-types {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .autocomplete-item .ac-types .type-badge {
    margin-left: 0;
    padding: 0.1rem 0.5rem;
    font-size: 0.68rem;
  }

  .autocomplete-empty {
    padding: 0.6rem;
    color: var(--text-dim);
    font-size: 0.85rem;
    font-style: italic;
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
    padding: 0.5rem 0.8rem;
    margin: 0.15rem 0.2rem;
    cursor: pointer;
    font-size: 0.8rem;
    min-height: 2.25rem;
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

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.9rem;
    padding: 3rem 1.5rem;
    text-align: center;
  }

  .empty-state img {
    opacity: 0.35;
    filter: grayscale(0.4);
  }

  .empty-state p {
    margin: 0;
    max-width: 26rem;
    color: var(--text-dim);
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .family-strip {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
  }

  .family-strip-stage {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .family-strip-arrow {
    color: var(--text-dim);
    font-size: 1.1rem;
    padding: 0 0.1rem;
  }

  .family-strip-item {
    display: block;
    text-decoration: none;
    text-align: center;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
    min-width: 7.5rem;
    transition: border-color 0.15s ease, transform 0.15s ease;
    touch-action: manipulation;
  }

  .family-strip-item:hover {
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .family-strip-icon {
    display: block;
    margin: 0 auto 0.3rem;
    object-fit: contain;
  }

  .family-strip-name {
    color: var(--text);
    font-weight: 700;
    font-size: 0.9rem;
    margin-bottom: 0.3rem;
    text-align: center;
  }

  .family-strip-badges { margin-bottom: 0.3rem; }

  .family-strip-rank {
    font-size: 0.78rem;
    color: var(--text-dim);
  }

  .pokemon-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 1.2rem 1.3rem;
  }

  .pokemon-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0.7rem;
    margin-bottom: 0.9rem;
  }

  .pokemon-card-title {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }

  .hero-thumb {
    flex-shrink: 0;
    object-fit: contain;
    background: radial-gradient(circle, rgba(255, 255, 255, 0.06) 0%, transparent 72%);
    border-radius: 50%;
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

  .pokemon-card.shadow-view {
    border-color: #8b5cf6;
    box-shadow: 0 0 0 1px rgba(139, 92, 246, 0.35);
  }

  .view-toggle {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0.15rem;
    background: var(--panel-alt);
  }

  .view-toggle-btn {
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: 0.78rem;
    font-weight: 700;
    padding: 0.55rem 0.9rem;
    border-radius: 999px;
    cursor: pointer;
    min-height: 2.25rem;
  }

  .view-toggle-btn.active {
    background: #8b5cf6;
    color: #fff;
  }

  .view-toggle-btn:not(.active):hover {
    color: var(--text);
  }

  .badge.shadow {
    background: #8b5cf6;
    color: #fff;
  }

  .type-badge {
    display: inline-block;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: capitalize;
    background: var(--blue);
    color: #fff;
    margin-left: 0.3rem;
  }

  /* Official-style Pokemon type colors. Text color is chosen per swatch
     for contrast, never a blanket white-on-everything. */
  .type-normal   { background: #A8A878; color: #35351f; }
  .type-fire     { background: #F08030; color: #ffffff; }
  .type-water    { background: #6890F0; color: #ffffff; }
  .type-electric { background: #F8D030; color: #4a3c00; }
  .type-grass    { background: #78C850; color: #14330a; }
  .type-ice      { background: #98D8D8; color: #0d4343; }
  .type-fighting { background: #C03028; color: #ffffff; }
  .type-poison   { background: #A040A0; color: #ffffff; }
  .type-ground   { background: #E0C068; color: #453210; }
  .type-flying   { background: #A890F0; color: #241454; }
  .type-psychic  { background: #F85888; color: #ffffff; }
  .type-bug      { background: #A8B820; color: #232d00; }
  .type-rock     { background: #B8A038; color: #332a0a; }
  .type-ghost    { background: #705898; color: #ffffff; }
  .type-dragon   { background: #7038F8; color: #ffffff; }
  .type-dark     { background: #705848; color: #ffffff; }
  .type-steel    { background: #B8B8D0; color: #23233a; }
  .type-fairy    { background: #EE99AC; color: #52142a; }

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

  .notable-facts {
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    padding: 1rem 1.2rem;
  }

  .notable-facts .section-heading {
    margin-top: 0;
  }

  .notable-sub {
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
  }

  .notable-facts ul {
    margin: 0;
    padding-left: 1.2rem;
  }

  .notable-facts li {
    font-size: 0.9rem;
    line-height: 1.6;
    margin-bottom: 0.35rem;
  }

  .notable-facts li:last-child { margin-bottom: 0; }

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
  .badge.lc { background: var(--panel-alt); color: var(--text-dim); border: 1px solid var(--border); }

  /* Community-tier heatmap: gray (F, worst) climbing through a genuine
     red -> orange -> olive -> green hue rotation (HSL-computed, not just
     "yellow" reused from --accent - that read as unstyled/default against
     the rest of the UI's existing gold accent) up to green (S and above).
     Index order matches script.js's TIER_ORDER =
     [F, D, C, B, A, S, SS, SSS, SSSS, SSSSS]. */
  .badge.tier-heat-0 { background: #6b7280; color: #ffffff; } /* F */
  .badge.tier-heat-1 { background: #ae2929; color: #ffffff; } /* D */
  .badge.tier-heat-2 { background: #ae6029; color: #ffffff; } /* C */
  .badge.tier-heat-3 { background: #ae9729; color: #1a1a1a; } /* B */
  .badge.tier-heat-4 { background: #81ae29; color: #1a1a1a; } /* A */
  .badge.tier-heat-5 { background: #29ae29; color: #1a1a1a; } /* S */
  .badge.tier-heat-6 { background: #298e3a; color: #1a1a1a; } /* SS */
  .badge.tier-heat-7 { background: #218341; color: #ffffff; } /* SSS */
  .badge.tier-heat-8 { background: #197647; color: #ffffff; } /* SSSS */
  .badge.tier-heat-9 {
    background: #14714f;
    color: #ffffff;
    box-shadow: 0 0 0 1px #fbbf24, 0 0 8px rgba(251, 191, 36, 0.5);
  } /* SSSSS - subtle gold ring for the top tier */

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

  /* Subtle zebra striping, layered under each league row's own color theme
     below - a small brightness nudge, never a hard color swap. */
  table.league-table tbody tr:nth-child(even) { filter: brightness(1.09); }

  /* Two-color league identities: a background wash from the first color,
     a solid left-edge accent bar from the second, and matching bright
     label text so each league reads as a distinct "brand" at a glance.
     Colors were chosen/paired so label text always sits on a dark base -
     never light text on a light wash. */
  table.league-table tr.league-row-littleCup {
    background: linear-gradient(90deg, rgba(34, 197, 94, 0.20), rgba(34, 197, 94, 0.04) 80%);
  }
  table.league-table tr.league-row-littleCup td:first-child { border-left: 4px solid #3b82f6; }
  table.league-table tr.league-row-littleCup .league-name { color: #86efac; }

  table.league-table tr.league-row-greatLeague {
    background: linear-gradient(90deg, rgba(37, 99, 235, 0.22), rgba(37, 99, 235, 0.04) 80%);
  }
  table.league-table tr.league-row-greatLeague td:first-child { border-left: 4px solid #ef4444; }
  table.league-table tr.league-row-greatLeague .league-name { color: #93c5fd; }

  table.league-table tr.league-row-summerLeague {
    background: linear-gradient(90deg, rgba(22, 163, 74, 0.20), rgba(22, 163, 74, 0.04) 80%);
  }
  table.league-table tr.league-row-summerLeague td:first-child { border-left: 4px solid #facc15; }
  table.league-table tr.league-row-summerLeague .league-name { color: #fde047; }

  table.league-table tr.league-row-ultraLeague {
    background: linear-gradient(90deg, rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0.08) 80%);
  }
  table.league-table tr.league-row-ultraLeague td:first-child { border-left: 4px solid #facc15; }
  table.league-table tr.league-row-ultraLeague .league-name { color: #fde047; }

  table.league-table tr.league-row-masterLeague {
    background: linear-gradient(90deg, rgba(124, 58, 237, 0.24), rgba(124, 58, 237, 0.05) 80%);
  }
  table.league-table tr.league-row-masterLeague td:first-child { border-left: 4px solid #f472b6; }
  table.league-table tr.league-row-masterLeague .league-name { color: #f9a8d4; }

  .league-name {
    font-weight: 700;
  }

  /* Rank highlight/star system: any "#N of M" figure in the app uses this -
     league rank, raid-attacker overall rank, type-attacker rank, and
     community tier rank all share the same visual language. */
  .rank-value {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .rank-value.rank-highlight {
    background: var(--accent);
    color: #1a1a1a;
    padding: 0.1rem 0.45rem;
    border-radius: 6px;
  }

  .rank-total {
    font-weight: 400;
    color: var(--text-dim);
    font-size: 0.85em;
  }

  .rank-value.rank-highlight .rank-total {
    color: #3a2f00;
  }

  .rank-stars {
    letter-spacing: -0.1em;
    font-size: 0.85em;
  }

  footer {
    text-align: center;
    padding: 1rem 1.5rem 2rem;
  }

  .legend {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.5rem 1.2rem;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-dim);
    font-size: 0.78rem;
  }

  .legend-item code {
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.05rem 0.4rem;
    color: var(--text);
  }

  @media (max-width: 560px) {
    table.league-table { font-size: 0.8rem; }
    table.league-table th, table.league-table td { padding: 0.4rem 0.35rem; }

    /* A lone-member stage (e.g. the root of a branching family) is only
       as wide as its one card, but flex-wrap still reserves a full row
       for it before the next stage wraps - leaving a large dead gap next
       to a small arrow. Stacking vertically instead reads naturally as
       a top-to-bottom evolution list on a narrow screen. */
    .family-strip {
      flex-direction: column;
      align-items: stretch;
    }

    .family-strip-stage {
      justify-content: center;
    }

    .family-strip-arrow {
      display: block;
      text-align: center;
      transform: rotate(90deg);
    }
  }
</style>
</head>
<body>

<header>
  <div class="brand">
    <img src="images/brand/logo.png" alt="" class="brand-logo" width="57" height="57">
    <h1>Pokecheck</h1>
  </div>
</header>

<main>
  <div class="search-panel">
    <div class="search-input-wrap">
      <input type="text" id="pokemon-input" placeholder="Search a Pokemon (e.g. Squirtle)" autocomplete="off">
      <ul class="autocomplete-list" id="autocomplete-list"></ul>
    </div>
    <button id="search-btn" type="button">Search</button>
  </div>
  <div class="quick-picks" id="recent-picks"></div>

  <div id="status-area"></div>
  <div id="results">
    <div class="empty-state" id="empty-state">
      <img src="images/brand/logo.png" alt="" width="72" height="72">
      <p>Search a Pokemon above to see its PvP-optimal IVs, league rankings, and raid attacker stats.</p>
    </div>
  </div>
</main>

<footer>
  <div class="legend">
    <span class="legend-item"><code>*</code> Community Day / Elite TM move</span>
    <span class="legend-item"><code>&dagger;</code> Legacy move</span>
  </div>
</footer>

<script src="jquery.min.js"></script>
<script src="script.js"></script>
</body>
</html>
