param([switch]$ReplaceExisting)
# 商店图标与侧栏图标独立维护。几何、颜色和文字仅来自 media/catlas-hub.svg。
# 这是本图稿的有限转换器，仅支持背景 rect、M/C 曲线和单行文字，不是通用 SVG 引擎。
# 默认拒绝覆盖；获得准确目标的当次许可后才能传入 -ReplaceExisting。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = Join-Path $projectRoot 'media/catlas-hub.svg'
$targetPath = Join-Path $projectRoot 'media/catlas-hub.png'
if ((Test-Path -LiteralPath $targetPath) -and -not $ReplaceExisting) { throw '目标 PNG 已存在；需确认覆盖范围后显式传入 -ReplaceExisting。' }
[xml]$source = Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8
if ($source.svg.viewBox -ne '0 0 1024 1024') { throw '图稿尺寸不受支持，请审查转换器。' }
$bitmap = [Drawing.Bitmap]::new(1024, 1024)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$outputBitmap = [Drawing.Bitmap]::new(256, 256)
$outputGraphics = [Drawing.Graphics]::FromImage($outputBitmap)
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    foreach ($element in $source.svg.ChildNodes) {
        if ($element -isnot [Xml.XmlElement]) { continue }
        if ($element.LocalName -eq 'rect') {
            $graphics.Clear([Drawing.ColorTranslator]::FromHtml($element.fill))
        } elseif ($element.LocalName -eq 'path') {
            $data = $element.GetAttribute('d')
            if ($data -notmatch '^M [-\d.]+ [-\d.]+(?: C(?: [-\d.]+){6})+$') { throw '路径必须仅包含 M/C 曲线。' }
            $values = @([regex]::Matches($data, '-?\d+(?:\.\d+)?') | ForEach-Object {
                [single]::Parse($_.Value, [Globalization.CultureInfo]::InvariantCulture)
            })
            $shape = [Drawing.Drawing2D.GraphicsPath]::new()
            $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml($element.stroke), [single]$element.GetAttribute('stroke-width'))
            try {
                $x = $values[0]; $y = $values[1]
                for ($i = 2; $i -lt $values.Count; $i += 6) {
                    $shape.AddBezier($x, $y, $values[$i], $values[$i+1], $values[$i+2], $values[$i+3], $values[$i+4], $values[$i+5])
                    $x = $values[$i+4]; $y = $values[$i+5]
                }
                $graphics.DrawPath($pen, $shape)
            } finally { $pen.Dispose(); $shape.Dispose() }
        } elseif ($element.LocalName -eq 'text') {
            # SVG textLength 固定字宽；按字体基线放置，避免 DrawString 的额外边距让文字突出。
            $family = [Drawing.FontFamily]::new($element.GetAttribute('font-family'))
            $shape = [Drawing.Drawing2D.GraphicsPath]::new()
            $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($element.fill))
            $matrix = [Drawing.Drawing2D.Matrix]::new()
            $format = [Drawing.StringFormat]::GenericTypographic
            try {
                $size = [single]$element.GetAttribute('font-size')
                $style = [Drawing.FontStyle]::Bold
                $ascent = $size * $family.GetCellAscent($style) / $family.GetEmHeight($style)
                $shape.AddString($element.InnerText, $family, [int]$style, $size, [Drawing.PointF]::new(0, 0), $format)
                $bounds = $shape.GetBounds()
                $scale = [single]$element.textLength / $bounds.Width
                $matrix.Translate(([single]$element.x - $bounds.X * $scale), ([single]$element.y - $ascent))
                $matrix.Scale($scale, 1)
                $shape.Transform($matrix)
                $graphics.FillPath($brush, $shape)
            } finally { $format.Dispose(); $matrix.Dispose(); $brush.Dispose(); $shape.Dispose(); $family.Dispose() }
        } else { throw "不支持的 SVG 元素：$($element.LocalName)" }
    }
    $outputGraphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
    $outputGraphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $outputGraphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $outputGraphics.DrawImage($bitmap, [Drawing.Rectangle]::new(0, 0, 256, 256))
    # 渲染全部成功后才打开固定输出目标；不删除源稿、不处理任何其他文件。
    $mode = if ($ReplaceExisting) { [IO.FileMode]::Create } else { [IO.FileMode]::CreateNew }
    $stream = [IO.File]::Open($targetPath, $mode, [IO.FileAccess]::Write)
    try { $outputBitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png) } finally { $stream.Dispose() }
    Write-Output '已生成 media/catlas-hub.png（256×256）；侧栏图标未修改。'
} finally {
    $outputGraphics.Dispose(); $outputBitmap.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
