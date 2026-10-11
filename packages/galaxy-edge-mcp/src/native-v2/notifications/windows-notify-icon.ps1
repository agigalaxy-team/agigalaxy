$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# This short-lived owned helper has no installation, registry or policy writes.
# Input is data. Never evaluate supplied strings or start a navigation command.
try {
    $requestLine = [Console]::In.ReadLine()
    if ($null -eq $requestLine -or $requestLine.Length -gt 2048) { throw 'invalid_request' }
    $notificationRequest = $requestLine | ConvertFrom-Json
    if ($notificationRequest.mode -notin @('probe', 'show')) { throw 'invalid_mode' }
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not [Environment]::UserInteractive) { throw 'desktop_unavailable' }
    if ($notificationRequest.mode -eq 'probe') {
        [Console]::WriteLine('{"event":"capabilities","available":true,"channel":"windows-notify-icon","displayEvidence":"BalloonTipShown","permission":"system-managed"}')
        exit 0
    }
    if ($notificationRequest.eventCount -isnot [int] -or $notificationRequest.eventCount -lt 1 -or $notificationRequest.eventCount -gt 20) { throw 'invalid_count' }
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;
public static class GalaxyNotification {
    private static int stopping;
    private static int displayed;
    public static void Run(int count, bool testOnly) {
        using (var icon = new NotifyIcon())
        using (var timer = new System.Windows.Forms.Timer()) {
            var started = DateTime.UtcNow;
            icon.Icon = SystemIcons.Information;
            icon.Text = "Galaxy";
            icon.BalloonTipTitle = testOnly ? "Galaxy notification test" : "Galaxy";
            // No title, source text, names, URLs or business payload enter the OS.
            icon.BalloonTipText = testOnly ? "Local capability test. No business item was sent." : count == 1
                ? "A new item needs your attention. Open Galaxy to check current access."
                : "New items need your attention. Open Galaxy to check current access.";
            icon.BalloonTipIcon = ToolTipIcon.Info;
            icon.BalloonTipShown += delegate {
                if (Interlocked.Exchange(ref displayed, 1) == 0)
                    Console.WriteLine("{\"event\":\"shown\",\"evidence\":\"BalloonTipShown\"}");
            };
            icon.BalloonTipClicked += delegate {
                Console.WriteLine("{\"event\":\"clicked\"}");
                Interlocked.Exchange(ref stopping, 1);
            };
            icon.BalloonTipClosed += delegate {
                Console.WriteLine("{\"event\":\"dismissed\"}");
                Interlocked.Exchange(ref stopping, 1);
            };
            var reader = new Thread(delegate() {
                try { Console.In.ReadLine(); } catch { }
                Interlocked.Exchange(ref stopping, 1);
            });
            reader.IsBackground = true;
            reader.Start();
            timer.Interval = 100;
            timer.Tick += delegate {
                if (Interlocked.CompareExchange(ref stopping, 0, 0) != 0
                    || (DateTime.UtcNow - started).TotalSeconds >= 15) {
                    icon.Visible = false;
                    Application.ExitThread();
                }
            };
            timer.Start();
            icon.Visible = true;
            icon.ShowBalloonTip(10000);
            Console.WriteLine("{\"event\":\"accepted\"}");
            Application.Run();
            icon.Visible = false;
            Console.WriteLine("{\"event\":\"closed\",\"displayConfirmed\":" + (displayed == 1 ? "true" : "false") + "}");
        }
    }
}
'@
    [GalaxyNotification]::Run($notificationRequest.eventCount, $notificationRequest.testOnly -eq $true)
} catch {
    # Exception strings can contain paths or data. Return a fixed safe status.
    [Console]::WriteLine('{"event":"unavailable","reason":"windows_notification_unavailable"}')
    exit 1
}
