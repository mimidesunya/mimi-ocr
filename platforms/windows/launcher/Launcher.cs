using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class Program {
    // WinForms 不要で MessageBox を表示するため user32.dll を直接呼ぶ
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    const uint MB_OK          = 0x00000000;
    const uint MB_ICONWARNING = 0x00000030;
    const uint MB_ICONERROR   = 0x00000010;

    [STAThread]
    static void Main() {
        try {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);

            string releaseAppDir = Path.Combine(exeDir, "app");
            string releaseElectronPath = Path.Combine(exeDir, "runtime", "electron", "electron.exe");
            string releaseNodePath = Path.Combine(exeDir, "runtime", "node", "node.exe");
            string releaseMainPath = Path.Combine(releaseAppDir, "dist", "src", "gui", "main.js");

            if (Directory.Exists(releaseAppDir) && File.Exists(releaseElectronPath) && File.Exists(releaseMainPath)) {
                Environment.SetEnvironmentVariable("MIMI_OCR_PROJECT_ROOT", releaseAppDir);
                Environment.SetEnvironmentVariable("MIMI_OCR_RELEASE", "1");
                if (File.Exists(releaseNodePath)) {
                    Environment.SetEnvironmentVariable("MIMI_OCR_NODE", releaseNodePath);
                } else {
                    Environment.SetEnvironmentVariable("MIMI_OCR_NODE", releaseElectronPath);
                }

                var releasePsi = new ProcessStartInfo {
                    FileName = releaseElectronPath,
                    Arguments = "\"" + releaseAppDir + "\"",
                    WorkingDirectory = releaseAppDir,
                    UseShellExecute = false
                };
                Process.Start(releasePsi);
                return;
            }

            // 開発時は bin フォルダから実行される前提
            string projectRoot = Path.GetFullPath(Path.Combine(exeDir, ".."));

            // node_modules が未インストールの場合はメッセージを表示して終了
            if (!Directory.Exists(Path.Combine(projectRoot, "node_modules"))) {
                MessageBoxW(
                    IntPtr.Zero,
                    "node_modules が見つかりません。\n" +
                    "初回起動前にプロジェクトフォルダで以下を実行してください:\n\n" +
                    "    npm install\n\n" +
                    "プロジェクトフォルダ:\n" + projectRoot,
                    "MIMI OCR - セットアップが必要です",
                    MB_OK | MB_ICONWARNING
                );
                return;
            }

            // UseShellExecute = true で npm を PATH から正しく検索できる
            var psi = new ProcessStartInfo {
                FileName        = "cmd.exe",
                Arguments       = "/c npm run gui",
                WorkingDirectory = projectRoot,
                WindowStyle     = ProcessWindowStyle.Hidden,
                UseShellExecute = true
            };

            Process.Start(psi);

        } catch (Exception ex) {
            MessageBoxW(
                IntPtr.Zero,
                "起動に失敗しました。\n\n" +
                "npm と node がインストールされているか確認してください。\n\n" +
                "エラー詳細:\n" + ex.Message,
                "MIMI OCR エラー",
                MB_OK | MB_ICONERROR
            );
        }
    }
}
