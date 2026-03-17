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
            // binフォルダから実行される前提
            string binDir = AppDomain.CurrentDomain.BaseDirectory;
            string projectRoot = Path.GetFullPath(Path.Combine(binDir, ".."));

            // node_modules が未インストールの場合はメッセージを表示して終了
            if (!Directory.Exists(Path.Combine(projectRoot, "node_modules"))) {
                MessageBoxW(
                    IntPtr.Zero,
                    "node_modules が見つかりません。\n" +
                    "初回起動前にプロジェクトフォルダで以下を実行してください:\n\n" +
                    "    npm install\n\n" +
                    "プロジェクトフォルダ:\n" + projectRoot,
                    "mimi-ocr - セットアップが必要です",
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
                "mimi-ocr エラー",
                MB_OK | MB_ICONERROR
            );
        }
    }
}
