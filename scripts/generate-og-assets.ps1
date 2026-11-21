Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $root -or -not (Test-Path "$root\index.html")) {
  $root = (Get-Location).Path
}

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-RadialGlow($g, [float]$cx, [float]$cy, [float]$radius, [System.Drawing.Color]$centerColor) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($cx - $radius, $cy - $radius, $radius * 2, $radius * 2)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
  $pgb.CenterPoint = New-Object System.Drawing.PointF($cx, $cy)
  $pgb.CenterColor = $centerColor
  $transparent = [System.Drawing.Color]::FromArgb(0, $centerColor.R, $centerColor.G, $centerColor.B)
  $pgb.SurroundColors = [System.Drawing.Color[]]@($transparent)
  $g.FillPath($pgb, $path)
  $pgb.Dispose()
  $path.Dispose()
}

$W = 1200
$H = 630
$bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

# 1. Deep Obsidian-Plum Editorial Canvas
$bgRect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $bgRect,
  [System.Drawing.Color]::FromArgb(255, 19, 10, 23),
  [System.Drawing.Color]::FromArgb(255, 13, 7, 17),
  35.0
)
$g.FillRectangle($bgBrush, $bgRect)
$bgBrush.Dispose()

# 2. Subtle Ambient Radial Glows
Draw-RadialGlow $g 180 110 420 ([System.Drawing.Color]::FromArgb(68, 255, 107, 139))
Draw-RadialGlow $g 940 315 390 ([System.Drawing.Color]::FromArgb(78, 132, 94, 194))
Draw-RadialGlow $g 880 180 280 ([System.Drawing.Color]::FromArgb(55, 255, 150, 113))
Draw-RadialGlow $g 520 580 340 ([System.Drawing.Color]::FromArgb(42, 214, 93, 177))

# 3. Editorial Glassmorphic Card Frame
$cardPath = New-RoundedRectPath 44 38 1112 554 30
$cardBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(44, 38, 1112, 554)),
  [System.Drawing.Color]::FromArgb(185, 34, 19, 39),
  [System.Drawing.Color]::FromArgb(210, 21, 12, 26),
  135.0
)
$g.FillPath($cardBrush, $cardPath)
$cardBrush.Dispose()

$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(75, 255, 158, 181), 1.6)
$g.DrawPath($borderPen, $cardPath)
$borderPen.Dispose()
$cardPath.Dispose()

# 4. Top-Left Brand Mark (icon-192.png clipped to rounded squircle) + Brand Name + Category Pill
$iconPath = Join-Path $root "icon-192.png"
if (Test-Path $iconPath) {
  $iconImg = [System.Drawing.Image]::FromFile($iconPath)
  $iconClip = New-RoundedRectPath 88 76 64 64 16
  $oldClip = $g.Clip
  $g.SetClip($iconClip)
  $g.DrawImage($iconImg, 88, 76, 64, 64)
  $g.Clip = $oldClip
  $iconBorderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 255, 160, 185), 1.4)
  $g.DrawPath($iconBorderPen, $iconClip)
  $iconBorderPen.Dispose()
  $iconClip.Dispose()
  $iconImg.Dispose()
}

$fontFamily = "Segoe UI"
$brandFont = New-Object System.Drawing.Font($fontFamily, 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 248, 251))
$g.DrawString("AifyCycle", $brandFont, $whiteBrush, 166, 82)

$subBrandFont = New-Object System.Drawing.Font($fontFamily, 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$mutedPinkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 232, 168, 188))
$g.DrawString("aifycycle.vercel.app", $subBrandFont, $mutedPinkBrush, 167, 114)

# Top-left eyebrow badge
$badgePath = New-RoundedRectPath 330 88 238 32 16
$badgeFill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 255, 107, 139))
$badgePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(110, 255, 107, 139), 1.2)
$g.FillPath($badgeFill, $badgePath)
$g.DrawPath($badgePen, $badgePath)
$badgeFont = New-Object System.Drawing.Font($fontFamily, 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$roseBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 150, 173))
$g.DrawString("AI-POWERED CYCLE TRACKER", $badgeFont, $roseBrush, 348, 97)
$badgePath.Dispose()

# 5. Punchy Editorial Headline (3 lines)
$h1Font = New-Object System.Drawing.Font($fontFamily, 52, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Intelligent Period &", $h1Font, $whiteBrush, 84, 178)

$gradHeadlineBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(84, 240, 560, 64)),
  [System.Drawing.Color]::FromArgb(255, 255, 122, 152),
  [System.Drawing.Color]::FromArgb(255, 255, 196, 138),
  0.0
)
$g.DrawString("Holistic Wellness", $h1Font, $gradHeadlineBrush, 84, 240)
$g.DrawString("Companion.", $h1Font, $whiteBrush, 84, 302)
$gradHeadlineBrush.Dispose()

# 6. Concise Editorial Subtitle
$subFont = New-Object System.Drawing.Font($fontFamily, 19, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(225, 214, 196, 211))
$g.DrawString("Precision cycle phase predictions, biological rhythm insights,", $subFont, $subBrush, 88, 388)
$g.DrawString("and private AI wellness coaching — local-first with cloud sync.", $subFont, $subBrush, 88, 417)

# 7. Bottom Feature Pills
$pills = @(
  @{ Text = "4-Phase Cycle Sync"; X = 88;  W = 178; Color = [System.Drawing.Color]::FromArgb(255, 255, 130, 158) },
  @{ Text = "Private AiFy AI Coach"; X = 278; W = 192; Color = [System.Drawing.Color]::FromArgb(255, 198, 155, 248) },
  @{ Text = "Local-First & Cloud"; X = 482; W = 182; Color = [System.Drawing.Color]::FromArgb(255, 110, 224, 212) }
)
$pillFont = New-Object System.Drawing.Font($fontFamily, 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
foreach ($p in $pills) {
  $pp = New-RoundedRectPath $p.X 492 $p.W 40 20
  $pf = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(28, $p.Color.R, $p.Color.G, $p.Color.B))
  $ppen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(95, $p.Color.R, $p.Color.G, $p.Color.B), 1.2)
  $ptb = New-Object System.Drawing.SolidBrush($p.Color)
  $g.FillPath($pf, $pp)
  $g.DrawPath($ppen, $pp)
  $g.DrawString($p.Text, $pillFont, $ptb, ($p.X + 18), 503)
  $pp.Dispose(); $pf.Dispose(); $ppen.Dispose(); $ptb.Dispose()
}

# 8. Right-Side Biological Cycle Dial Graphic (cx=935, cy=315)
$cx = 935.0
$cy = 315.0
$rOuter = 172.0

# Soft glass backing circle
$dialBgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$dialBgPath.AddEllipse($cx - 200, $cy - 200, 400, 400)
$dialBgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(95, 16, 9, 20))
$dialBgPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(45, 255, 255, 255), 1.2)
$g.FillPath($dialBgBrush, $dialBgPath)
$g.DrawPath($dialBgPen, $dialBgPath)
$dialBgPath.Dispose()

# Track ring
$trackPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(35, 255, 255, 255), 20)
$g.DrawEllipse($trackPen, $cx - $rOuter, $cy - $rOuter, $rOuter * 2, $rOuter * 2)
$trackPen.Dispose()

# 4 Phase Arcs (Menstrual, Follicular, Ovulatory, Luteal)
$arcs = @(
  @{ Start = -85; Sweep = 62;  Color = [System.Drawing.Color]::FromArgb(245, 255, 107, 139) },
  @{ Start = -13; Sweep = 84;  Color = [System.Drawing.Color]::FromArgb(245, 152, 108, 224) },
  @{ Start = 81;  Sweep = 56;  Color = [System.Drawing.Color]::FromArgb(255, 255, 158, 113) },
  @{ Start = 147; Sweep = 118; Color = [System.Drawing.Color]::FromArgb(240, 40, 178, 188) }
)
$arcRect = New-Object System.Drawing.RectangleF(($cx - $rOuter), ($cy - $rOuter), ($rOuter * 2), ($rOuter * 2))
foreach ($a in $arcs) {
  $pen = New-Object System.Drawing.Pen($a.Color, 20)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawArc($pen, $arcRect, $a.Start, $a.Sweep)
  $pen.Dispose()
}

# Active Day Marker on Ovulatory Arc (angle = 110 deg)
$angRad = 110.0 * [Math]::PI / 180.0
$mx = $cx + $rOuter * [Math]::Cos($angRad)
$my = $cy + $rOuter * [Math]::Sin($angRad)
Draw-RadialGlow $g $mx $my 30 ([System.Drawing.Color]::FromArgb(180, 255, 190, 130))
$markerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$markerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 140, 105), 4)
$g.FillEllipse($markerBrush, $mx - 11, $my - 11, 22, 22)
$g.DrawEllipse($markerPen, $mx - 11, $my - 11, 22, 22)

# Inner Dial Hub Labels
$centerFormat = New-Object System.Drawing.StringFormat
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center

$tagFont = New-Object System.Drawing.Font($fontFamily, 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$peachBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 176, 136))
$g.DrawString("CURRENT CYCLE", $tagFont, $peachBrush, $cx, ($cy - 76), $centerFormat)

$dayFont = New-Object System.Drawing.Font($fontFamily, 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Day 14", $dayFont, $whiteBrush, $cx, ($cy - 52), $centerFormat)

$phaseFont = New-Object System.Drawing.Font($fontFamily, 18, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Ovulatory Phase", $phaseFont, $peachBrush, $cx, ($cy + 14), $centerFormat)

$pillHub = New-RoundedRectPath ($cx - 86) ($cy + 48) 172 30 15
$pillHubBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(42, 255, 158, 113))
$g.FillPath($pillHubBrush, $pillHub)
$hubSubFont = New-Object System.Drawing.Font($fontFamily, 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Est. Peak Vitality", $hubSubFont, $whiteBrush, $cx, ($cy + 55), $centerFormat)
$pillHub.Dispose()

$g.Dispose()

# Save 1200x630 PNG and JPEG (<300 KB)
$pngPath = Join-Path $root "og-image.png"
$jpgPath = Join-Path $root "og-image.jpg"

$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$jpgCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 90L)
$bmp.Save($jpgPath, $jpgCodec, $encParams)
$bmp.Dispose()

# Generate valid favicon.ico (wrapping 32x32 PNG in ICO container)
$fav32Path = Join-Path $root "favicon-32x32.png"
$icoPath = Join-Path $root "favicon.ico"
if (Test-Path $fav32Path) {
  $pngBytes = [System.IO.File]::ReadAllBytes($fav32Path)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  # ICONDIR (Reserved=0, Type=1, Count=1)
  $bw.Write([uint16]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]1)
  # ICONDIRENTRY (Width=32, Height=32, ColorCount=0, Reserved=0, Planes=1, BitCount=32, BytesInRes, ImageOffset=22)
  $bw.Write([byte]32)
  $bw.Write([byte]32)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$pngBytes.Length)
  $bw.Write([uint32]22)
  $bw.Write($pngBytes)
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
  $bw.Dispose()
  $ms.Dispose()
}

Write-Output "Generated og-image.png: $((Get-Item $pngPath).Length) bytes"
Write-Output "Generated og-image.jpg: $((Get-Item $jpgPath).Length) bytes"
Write-Output "Generated favicon.ico:  $((Get-Item $icoPath).Length) bytes"
