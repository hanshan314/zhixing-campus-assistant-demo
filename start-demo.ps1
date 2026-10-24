param([switch]$VerifyOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$demoRoot = Split-Path -Parent $PSCommandPath
$runRoot = 'E:\ai比赛\交互端\docs\coordination\demo-runs\20261023-local-01'
$freezePath = Join-Path $runRoot 'web-local-build-freeze.json'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$previewPath = Join-Path $demoRoot 'scripts\preview-local.mjs'
$dataPath = Join-Path $demoRoot 'data'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw '未找到本机 Node.js，无法启动演示。'
}
if (-not (Test-Path -LiteralPath $freezePath -PathType Leaf)) {
    throw '缺少前端负责人冻结的网页构建记录。'
}
if (-not (Test-Path -LiteralPath $previewPath -PathType Leaf)) {
    throw '缺少演示启动文件。'
}

$freeze = Get-Content -LiteralPath $freezePath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($entry in $freeze.output_files) {
    $filePath = Join-Path (Join-Path $runRoot 'web-current-local') ([string]$entry.path)
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
        throw "冻结的网页文件缺失：$filePath"
    }
    $actual = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne [string]$entry.sha256) {
        throw "网页文件与冻结记录不一致：$filePath"
    }
}

if ($VerifyOnly) {
    Write-Host "已核对 $($freeze.output_files.Count) 个网页文件。"
    return
}

New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$previousDataPath = $env:DEMO_DATA_DIR
try {
    $env:DEMO_DATA_DIR = $dataPath
    Write-Host '演示地址：http://127.0.0.1:18766/'
    Write-Host '仅使用虚拟演示数据。保持此窗口打开；按 Ctrl+C 停止。'
    & $nodePath $previewPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    $env:DEMO_DATA_DIR = $previousDataPath
}
