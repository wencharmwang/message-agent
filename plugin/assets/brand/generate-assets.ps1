Add-Type -AssemblyName System.Drawing

$green = [System.Drawing.ColorTranslator]::FromHtml('#07C160')
$white = [System.Drawing.Color]::White
$assetRoot = $PSScriptRoot

function Add-RoundedRectangle {
  param(
    [System.Drawing.Drawing2D.GraphicsPath]$Path,
    [single]$X,
    [single]$Y,
    [single]$Width,
    [single]$Height,
    [single]$Radius
  )
  $diameter = $Radius * 2
  $Path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $Path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $Path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $Path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $Path.CloseFigure()
}

function Draw-ChatSymbol {
  param(
    [System.Drawing.Graphics]$Graphics,
    [single]$X,
    [single]$Y,
    [single]$Size
  )
  $scale = $Size / 64
  $bubble = [System.Drawing.Drawing2D.GraphicsPath]::new()
  Add-RoundedRectangle $bubble ($X + 5 * $scale) ($Y + 9 * $scale) (54 * $scale) (39 * $scale) (7 * $scale)
  $tail = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($X + 12 * $scale, $Y + 43 * $scale),
    [System.Drawing.PointF]::new($X + 12 * $scale, $Y + 54.9 * $scale),
    [System.Drawing.PointF]::new($X + 15.2 * $scale, $Y + 56.5 * $scale),
    [System.Drawing.PointF]::new($X + 29 * $scale, $Y + 46.5 * $scale)
  )
  $greenBrush = [System.Drawing.SolidBrush]::new($green)
  $whiteBrush = [System.Drawing.SolidBrush]::new($white)
  try {
    $Graphics.FillPath($greenBrush, $bubble)
    $Graphics.FillPolygon($greenBrush, $tail)
    foreach ($center in 22, 32, 42) {
      $diameter = 6.4 * $scale
      $Graphics.FillEllipse($whiteBrush, $X + ($center - 3.2) * $scale, $Y + 25.8 * $scale, $diameter, $diameter)
    }
  } finally {
    $bubble.Dispose()
    $greenBrush.Dispose()
    $whiteBrush.Dispose()
  }
}

function New-TransparentCanvas {
  param([int]$Width, [int]$Height)
  $bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  return @($bitmap, $graphics)
}

$symbolCanvas = New-TransparentCanvas 1254 1254
$symbol = $symbolCanvas[0]
$symbolGraphics = $symbolCanvas[1]
try {
  Draw-ChatSymbol $symbolGraphics 78 78 1098
  $symbol.Save((Join-Path $assetRoot 'message-agent-symbol.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $symbolGraphics.Dispose()
  $symbol.Dispose()
}

$logoCanvas = New-TransparentCanvas 2172 724
$logo = $logoCanvas[0]
$logoGraphics = $logoCanvas[1]
try {
  Draw-ChatSymbol $logoGraphics 54 60 604
  $font = [System.Drawing.Font]::new('Segoe UI', 150, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $textBrush = [System.Drawing.SolidBrush]::new($green)
  try {
    $logoGraphics.DrawString('Message Agent', $font, $textBrush, 690, 250)
  } finally {
    $font.Dispose()
    $textBrush.Dispose()
  }
  $logo.Save((Join-Path $assetRoot 'message-agent-logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $logoGraphics.Dispose()
  $logo.Dispose()
}
