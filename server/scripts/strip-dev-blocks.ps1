# strip-dev-blocks.ps1 -- release-time pass that removes operator-only
# / architecture-leaking content from the served main.<HASH>.js and
# refreshes the SRI integrity entry in index.html so the browser's
# integrity check succeeds against the post-strip bytes.
#
# Why a build-time strip (not source-time):
#   The source file (source/webclient/classicuo-wasm/wwwroot/main.js)
#   stays intact for debuggability + future maintenance. The strip
#   only mutates the SERVED bytes, leaving the source-of-truth as a
#   complete record of intent.
#
# What it strips:
#   1. The `if (devMode) { ... }` block -- server-controlled dev-login
#      button injection. Server already gates this at runtime via
#      /api/config; this strip removes the static code that would
#      otherwise be visible in DevTools "Sources" panel even though
#      it never executes on prod.
#   2. Line comments containing operator-only architecture keywords:
#      "Mercury", "deputy", ".NET 10 MT", "MAIN_THREAD_". These leak
#      the C#-WASM runtime choice (a competitive advantage we keep
#      private) and the deputy-worker pattern used to dispatch C#
#      onto a side worker.
#   3. Multi-line `/* ... */` comments that contain any of the above
#      keywords. Conservative: only strips the comment block, not
#      surrounding code.
#
# What it does NOT touch:
#   - String literals (operator may want to grep for "Mercury" in
#     runtime logs).
#   - .wasm binary (the C# string table is separately handled by
#     `WasmDevTrace=false` -p flag during AOT publish, which the
#     release flow already sets via `build.bat prod`).
#
# Sibling: server/scripts/strip-dev-blocks.sh used by release.sh on
# Linux/macOS -- must produce byte-identical output.
#
# Args:
#   -ClientDir <path>   Required. The release client/ directory; the
#                       script touches its `main.<HASH>.js` and
#                       `index.html`.
#
# Exit codes:
#   0 - strip completed (or was a no-op because nothing matched)
#   1 - strip failed (no main.js found, unexpected balance failure,
#       or required HTML integrity entry not found)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$ClientDir
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# Normalise to absolute path: .NET I/O APIs use the process working
# directory (not PowerShell's $PWD), so a relative -ClientDir like
# `client` resolves wrong when the script is invoked from any other
# working dir. Resolve-Path forces absolute via PowerShell semantics.
$ClientDir = (Resolve-Path -LiteralPath $ClientDir).ProviderPath
$indexPath = Join-Path $ClientDir 'index.html'
if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "index.html not found: $indexPath"
}

# Find the single main.<HASH>.js at the client/ root.
$mainCandidates = Get-ChildItem -LiteralPath $ClientDir -Filter 'main.*.js' -File
if ($mainCandidates.Count -eq 0) {
    Write-Error "No main.*.js found under $ClientDir"
    exit 1
}
if ($mainCandidates.Count -gt 1) {
    Write-Error ("Multiple main.*.js found under " + $ClientDir + " -- expected 1: " + ($mainCandidates.Name -join ', '))
    exit 1
}
$mainFile = $mainCandidates[0]

# --- Read main.js as UTF-8 (no BOM) ---
$rawBytes = [System.IO.File]::ReadAllBytes($mainFile.FullName)
$text = $utf8NoBom.GetString($rawBytes)
if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
    $text = $text.Substring(1)
}
$originalLen = $text.Length

# --- Strip pass 1: the `if (devMode) { ... }` block ---
# Balanced-brace walk because regex can't match balanced { }.
function Remove-IfBlockByMarker {
    param([string]$Source, [string]$Marker)
    $idx = $Source.IndexOf($Marker)
    if ($idx -lt 0) { return $Source }
    # Find the opening brace AT the end of the marker (marker includes "{").
    $openIdx = $Source.IndexOf('{', $idx)
    if ($openIdx -lt 0) { return $Source }
    $depth = 1
    $i = $openIdx + 1
    while ($i -lt $Source.Length -and $depth -gt 0) {
        $c = $Source[$i]
        if ($c -eq '{') { $depth++ }
        elseif ($c -eq '}') { $depth-- }
        $i++
    }
    if ($depth -ne 0) {
        Write-Warning "Brace walk failed to balance -- leaving block intact"
        return $Source
    }
    # $i is now the index AFTER the closing brace. Also consume the trailing
    # newline + leading whitespace on the line containing the marker so the
    # post-strip text doesn't have a phantom blank-line gap.
    $end = $i
    while ($end -lt $Source.Length -and ($Source[$end] -eq "`r" -or $Source[$end] -eq "`n")) {
        $end++
    }
    # Walk back to the start of the marker's indentation.
    $start = $idx
    while ($start -gt 0 -and ($Source[$start - 1] -eq ' ' -or $Source[$start - 1] -eq "`t")) {
        $start--
    }
    return $Source.Substring(0, $start) + $Source.Substring($end)
}

$beforePass1 = $text.Length
$text = Remove-IfBlockByMarker -Source $text -Marker 'if (devMode)'
$pass1Removed = $beforePass1 - $text.Length
if ($pass1Removed -gt 0) {
    Write-Host ("  [pass1] removed `if (devMode) { ... }` block (" + $pass1Removed + " chars)")
}

# --- Strip pass 2: line comments containing forbidden keywords ---
# Strip the WHOLE line (including the line terminator) when a `// ...`
# comment line mentions Mercury / deputy / .NET 10 MT / MAIN_THREAD_.
# Keywords are case-sensitive (these are proper-noun project names).
$lineKeywords = @(
    'Mercury'
    'deputy'
    '\.NET 10 MT'
    'MAIN_THREAD_'
)
$linePattern = '(?m)^[ \t]*//.*(' + ($lineKeywords -join '|') + ').*\r?\n'
$beforePass2 = $text.Length
$text = [regex]::Replace($text, $linePattern, '')
$pass2Removed = $beforePass2 - $text.Length
if ($pass2Removed -gt 0) {
    Write-Host ("  [pass2] removed " + $pass2Removed + " chars of single-line `// ...` comments with sensitive keywords")
}

# --- Strip pass 3: multi-line /* ... */ blocks with forbidden keywords ---
# Conservative: only strip the WHOLE block when one of its lines mentions
# a sensitive keyword. Don't strip the surrounding code.
$blockKeywords = @(
    'Mercury'
    'deputy'
    '\.NET 10 MT'
    'MAIN_THREAD_'
)
$blockPattern = '(?s)/\*[^*]*?(?:\*(?!/)[^*]*?)*?(' + ($blockKeywords -join '|') + ')[^*]*?(?:\*(?!/)[^*]*?)*?\*/'
$beforePass3 = $text.Length
$text = [regex]::Replace($text, $blockPattern, '')
$pass3Removed = $beforePass3 - $text.Length
if ($pass3Removed -gt 0) {
    Write-Host ("  [pass3] removed " + $pass3Removed + " chars of multi-line `/* ... */` blocks with sensitive keywords")
}

# --- Strip pass 4: standalone console.{log,warn,info,debug,trace}(...)
# whose first arg leaks a sensitive keyword (e.g. console.log('[mt-canvas]
# transferred canvas to deputy worker'). With the flag-file engaged these
# calls are no-ops at runtime, but the source line is still visible in
# DevTools "Sources" panel. We only strip statement-level calls (own
# line, semicolon-terminated) to avoid breaking expressions.
$consoleKeywords = @(
    'Mercury'
    'deputy'
    '\.NET 10 MT'
    'MAIN_THREAD_'
    'mt-canvas'
)
$consolePattern = '(?m)^[ \t]*console\.\w+\([^)]*(' + ($consoleKeywords -join '|') + ')[^)]*\);\r?\n'
$beforePass4 = $text.Length
$text = [regex]::Replace($text, $consolePattern, '')
$pass4Removed = $beforePass4 - $text.Length
if ($pass4Removed -gt 0) {
    Write-Host ("  [pass4] removed " + $pass4Removed + " chars of standalone console.X() calls with sensitive keywords")
}

# --- Strip pass 5 (final): all remaining comments via esbuild ---
# Parser-aware sweep. Regex strips would corrupt `//` inside strings,
# template literals, and regex literals; esbuild parses the JS and
# drops every comment safely. Runs LAST so passes 1-4 see the
# original source (their regex patterns target the source as
# authored, not esbuild's emit format).
#
# Flags:
#   --bundle=false                don't follow imports
#   --legal-comments=none         strip license / @preserve / etc.
#   --minify-whitespace=false     keep readable indentation
#   --minify-identifiers=false    no name mangling
#   --minify-syntax=false         no syntax transforms
#   --format=esm --target=esnext  keep modern JS as-is
#
# esbuild injects `/* @__PURE__ */` tree-shaking hints; a final
# regex pass sweeps those (they ARE comments, just not authored).
$esbuild = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\.bin\esbuild.cmd'
if (Test-Path -LiteralPath $esbuild) {
    # GetTempFileName produces .tmp; esbuild infers loader from extension
    # and fails on .tmp ("No loader is configured for .tmp files"). Use a
    # .js-suffixed sibling so esbuild picks the JS loader automatically.
    $tmpInBase = [System.IO.Path]::GetTempFileName()
    Remove-Item -LiteralPath $tmpInBase -Force -ErrorAction SilentlyContinue
    $tmpIn  = $tmpInBase + '.js'
    $tmpOut = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllBytes($tmpIn, $utf8NoBom.GetBytes($text))
        $proc = Start-Process -FilePath $esbuild `
            -ArgumentList @(
                '--bundle=false',
                '--legal-comments=none',
                # minify-whitespace=true is the flag that ALSO drops
                # comments (legal-comments alone only handles /*! @license */
                # blocks; non-legal // line comments are kept unless we
                # also collapse whitespace). Accepted trade: post-strip
                # file is a single long line. Identifiers are NOT
                # mangled (--minify-identifiers=false), so error stack
                # traces remain meaningful and integration tests pass.
                '--minify-whitespace=true',
                '--minify-identifiers=false',
                '--minify-syntax=false',
                '--format=esm',
                '--target=esnext',
                $tmpIn
            ) `
            -NoNewWindow `
            -Wait `
            -RedirectStandardOutput $tmpOut `
            -PassThru
        if ($proc.ExitCode -ne 0) {
            Write-Error "  [pass5] esbuild exited $($proc.ExitCode)"
            exit 1
        }
        $beforePass5 = $text.Length
        $esbuildOut = [System.IO.File]::ReadAllBytes($tmpOut)
        $text = $utf8NoBom.GetString($esbuildOut)
        if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) {
            $text = $text.Substring(1)
        }
        # Sweep esbuild's tree-shaking annotations.
        $text = [regex]::Replace($text, '/\*\s*@__PURE__\s*\*/\s*', '')
        $pass5Removed = $beforePass5 - $text.Length
        Write-Host ("  [pass5] esbuild comment-strip: " + $pass5Removed + " chars delta")
    } finally {
        if (Test-Path -LiteralPath $tmpIn)  { Remove-Item -LiteralPath $tmpIn  -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $tmpOut) { Remove-Item -LiteralPath $tmpOut -Force -ErrorAction SilentlyContinue }
    }
} else {
    Write-Warning "  [pass5] esbuild not found at $esbuild -- skipping final comment-strip"
}

$totalRemoved = $originalLen - $text.Length
if ($totalRemoved -eq 0) {
    Write-Host ("  [strip-dev-blocks] nothing to strip in " + $mainFile.Name + " -- exiting clean")
    exit 0
}

# --- Write the stripped file back as UTF-8 without BOM ---
$newBytes = $utf8NoBom.GetBytes($text)
[System.IO.File]::WriteAllBytes($mainFile.FullName, $newBytes)

# --- Recompute SHA-256 + base64 ---
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($newBytes)
$b64 = [Convert]::ToBase64String($sha)
$newIntegrity = "sha256-" + $b64

# v0.7.9 re-fingerprint: the WASM SDK fingerprints main.<hash>.js from its
# PRE-strip content, but we just mutated the bytes. Keeping the same filename
# lets a dev (un-stripped) build and a prod (stripped) build serve DIFFERENT
# bytes under the SAME `immutable`-cached name -> any client/CDN that cached
# the other variant SRI-blocks main.js ("Failed to find a valid digest") ->
# black screen until a manual cache purge. Rename to a token derived from the
# STRIPPED bytes so dev/prod never collide, and poisoned immutable caches MISS
# the new name -> refetch fresh automatically. Token = first 10 lowercased
# alphanumerics of the stripped-content base64 sha (identical derivation in the
# .sh sibling for byte-identical cross-platform output).
$oldName = $mainFile.Name
$token = ($b64 -replace '[^a-zA-Z0-9]', '').ToLower().Substring(0, 10)
$newName = "main." + $token + ".js"

if ($newName -ne $oldName) {
    Move-Item -LiteralPath $mainFile.FullName -Destination (Join-Path $ClientDir $newName) -Force
    # Drop the pre-rename .br twin (regenerated for the new name downstream).
    $oldBr = $mainFile.FullName + '.br'
    if (Test-Path -LiteralPath $oldBr) { Remove-Item -LiteralPath $oldBr -Force }
    Write-Host ("  [strip-dev-blocks] re-fingerprinted " + $oldName + " -> " + $newName)
}
Write-Host ("  [strip-dev-blocks] " + $newName + " -> " + $newIntegrity + " (total -" + $totalRemoved + " chars)")

# --- Patch index.html: integrity VALUE on old name, then rewrite EVERY ref ---
# (importmap remap value, integrity key, <script src>). verify-sri (run
# post-strip by release.bat/.sh) is the downstream guardrail.
$indexBytes = [System.IO.File]::ReadAllBytes($indexPath)
$indexText = $utf8NoBom.GetString($indexBytes)
if ($indexText.Length -gt 0 -and [int][char]$indexText[0] -eq 0xFEFF) {
    $indexText = $indexText.Substring(1)
}

$escaped = [regex]::Escape($oldName)
$rx = '"\./' + $escaped + '":\s*"sha256-[A-Za-z0-9+/=]+"'
$newEntry = '"./' + $oldName + '": "' + $newIntegrity + '"'
$rxMatches = [regex]::Matches($indexText, $rx)
if ($rxMatches.Count -eq 0) {
    Write-Error ("  no integrity entry for " + $oldName + " in index.html")
    exit 1
}
$indexText = [regex]::Replace($indexText, $rx, $newEntry)
# Literal replace of every old-filename occurrence with the new name.
$indexText = $indexText.Replace($oldName, $newName)

[System.IO.File]::WriteAllText($indexPath, $indexText, $utf8NoBom)
Write-Host '  [strip-dev-blocks] index.html integrity + filename refreshed'
