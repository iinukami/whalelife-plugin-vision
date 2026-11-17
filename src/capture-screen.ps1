# Copyright (c) 2026 iinukami and contributors.
# SPDX-License-Identifier: AGPL-3.0-only
# Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
param(
    [ValidateSet('snapshot', 'observe')][string]$Mode = 'snapshot',
    [ValidateSet('screen', 'window')][string]$Target = 'window',
    [ValidateRange(0, 60)][double]$Seconds = 0,
    [ValidateSet(1, 2, 4, 6)][int]$Fps = 2,
    [ValidateSet(640, 1600)][int]$MaxSide = 640
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$screenFailureCode = 'capture_failed'
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WhaleLifeScreenNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
}
'@
    [void][WhaleLifeScreenNative]::SetProcessDPIAware()
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    if ($Mode -eq 'observe' -and $Seconds -lt 2) { throw 'Invalid duration' }
    $screenWindow = [IntPtr]::Zero
    [uint32]$screenProcess = 0
    if ($Target -eq 'window') {
        $screenWindow = [WhaleLifeScreenNative]::GetForegroundWindow()
        if ($screenWindow -eq [IntPtr]::Zero) { $screenFailureCode = 'target_unavailable'; throw 'No foreground window' }
        [void][WhaleLifeScreenNative]::GetWindowThreadProcessId($screenWindow, [ref]$screenProcess)
    }
    $screenTargetId = [Guid]::NewGuid().ToString('N')
    $screenJpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $screenEncoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $screenEncoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
    $screenClock = [System.Diagnostics.Stopwatch]::StartNew()
    $screenNext = 0.0
    $screenFrameCount = 0
    try {
        while ($true) {
            $screenWait = $screenNext - $screenClock.Elapsed.TotalSeconds
            if ($screenWait -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($screenWait * 1000)) }
            if ($Target -eq 'window') {
                [uint32]$screenCurrentProcess = 0
                [void][WhaleLifeScreenNative]::GetWindowThreadProcessId($screenWindow, [ref]$screenCurrentProcess)
                if (![WhaleLifeScreenNative]::IsWindow($screenWindow) -or ![WhaleLifeScreenNative]::IsWindowVisible($screenWindow) -or
                    [WhaleLifeScreenNative]::IsIconic($screenWindow) -or $screenCurrentProcess -ne $screenProcess) {
                    $screenFailureCode = 'target_unavailable'; throw 'Target no longer visible'
                }
                $screenRect = New-Object WhaleLifeScreenNative+RECT
                if (![WhaleLifeScreenNative]::GetWindowRect($screenWindow, [ref]$screenRect)) {
                    $screenFailureCode = 'target_unavailable'; throw 'Target rectangle unavailable'
                }
                $screenDwmRect = New-Object WhaleLifeScreenNative+RECT
                if ([WhaleLifeScreenNative]::DwmGetWindowAttribute($screenWindow, 9, [ref]$screenDwmRect, 16) -eq 0) { $screenRect = $screenDwmRect }
                $screenBounds = New-Object System.Drawing.Rectangle($screenRect.Left, $screenRect.Top, ($screenRect.Right - $screenRect.Left), ($screenRect.Bottom - $screenRect.Top))
                $screenBounds = [System.Drawing.Rectangle]::Intersect($screenBounds, [System.Windows.Forms.SystemInformation]::VirtualScreen)
            } else { $screenBounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }
            if ($screenBounds.Width -lt 1 -or $screenBounds.Height -lt 1 -or [double]$screenBounds.Width * $screenBounds.Height -gt 40000000) {
                $screenFailureCode = 'target_unavailable'; throw 'Target rectangle outside limits'
            }
            $screenAt = $screenClock.Elapsed.TotalSeconds
            $screenCapturedAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            $screenBitmap = $null; $screenGraphics = $null; $screenOutput = $null; $screenScaledGraphics = $null; $screenStream = $null
            try {
                $screenBitmap = New-Object System.Drawing.Bitmap($screenBounds.Width, $screenBounds.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
                $screenGraphics = [System.Drawing.Graphics]::FromImage($screenBitmap)
                $screenGraphics.CopyFromScreen($screenBounds.Location, [System.Drawing.Point]::Empty, $screenBounds.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
                $screenRatio = [Math]::Min(1.0, $MaxSide / [double][Math]::Max($screenBounds.Width, $screenBounds.Height))
                $screenWidth = [Math]::Max(1, [int][Math]::Round($screenBounds.Width * $screenRatio))
                $screenHeight = [Math]::Max(1, [int][Math]::Round($screenBounds.Height * $screenRatio))
                $screenOutput = New-Object System.Drawing.Bitmap($screenWidth, $screenHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
                $screenScaledGraphics = [System.Drawing.Graphics]::FromImage($screenOutput)
                $screenScaledGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $screenScaledGraphics.DrawImage($screenBitmap, 0, 0, $screenWidth, $screenHeight)
                $screenStream = New-Object System.IO.MemoryStream
                $screenOutput.Save($screenStream, $screenJpegCodec, $screenEncoderParameters)
                if ($screenStream.Length -gt 4194304) { throw 'Frame too large' }
                $screenRecord = @{ type='frame'; atSeconds=$screenAt; capturedAt=$screenCapturedAt; targetId=$screenTargetId;
                    width=$screenWidth; height=$screenHeight; jpeg=[Convert]::ToBase64String($screenStream.ToArray()) }
                [Console]::WriteLine(($screenRecord | ConvertTo-Json -Compress))
                [Console]::Out.Flush()
                $screenFrameCount++
            } finally {
                if ($null -ne $screenStream) { $screenStream.Dispose() }
                if ($null -ne $screenScaledGraphics) { $screenScaledGraphics.Dispose() }
                if ($null -ne $screenOutput) { $screenOutput.Dispose() }
                if ($null -ne $screenGraphics) { $screenGraphics.Dispose() }
                if ($null -ne $screenBitmap) { $screenBitmap.Dispose() }
            }
            if ($Mode -eq 'snapshot' -or $screenAt -ge $Seconds) { break }
            if ($screenFrameCount -gt [Math]::Ceiling($Seconds * $Fps) + 3) { throw 'Frame limit exceeded' }
            # Skip missed beats; retain a final capture at/after the requested end, never stop on output frame quota.
            $screenNext = [Math]::Min($Seconds, [Math]::Max($screenNext + 1.0 / $Fps, $screenClock.Elapsed.TotalSeconds))
        }
    } finally { $screenEncoderParameters.Dispose(); $screenClock.Stop() }
    exit 0
} catch {
    # No exception text, titles, pixel data or file paths in diagnostics.
    [Console]::WriteLine((@{type='error';code=$screenFailureCode} | ConvertTo-Json -Compress))
    exit 1
}
