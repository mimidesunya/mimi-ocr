#ifndef UNICODE
#define UNICODE
#endif

#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <stdio.h>
#include <wchar.h>

#define APP_TITLE L"MIMI OCR"

static int remove_last_path_component(wchar_t *path) {
    wchar_t *last_slash = NULL;

    for (wchar_t *p = path; *p; ++p) {
        if (*p == L'\\' || *p == L'/') {
            last_slash = p;
        }
    }

    if (!last_slash) {
        return 0;
    }

    *last_slash = L'\0';
    return 1;
}

static int join_path(wchar_t *dest, size_t dest_len, const wchar_t *left, const wchar_t *right) {
    const wchar_t *separator = L"";
    size_t left_len = wcslen(left);

    if (left_len > 0 && left[left_len - 1] != L'\\' && left[left_len - 1] != L'/') {
        separator = L"\\";
    }

    int written = swprintf(dest, dest_len, L"%ls%ls%ls", left, separator, right);
    return written > 0 && (size_t)written < dest_len;
}

static void show_message(const wchar_t *title, const wchar_t *message, UINT icon) {
    MessageBoxW(NULL, message, title, MB_OK | icon);
}

static int is_directory(const wchar_t *path) {
    DWORD attrs = GetFileAttributesW(path);
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static int is_file(const wchar_t *path) {
    DWORD attrs = GetFileAttributesW(path);
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous_instance, PWSTR command_line, int show_command) {
    (void)instance;
    (void)previous_instance;
    (void)command_line;
    (void)show_command;

    wchar_t exe_path[32768];
    wchar_t exe_dir[32768];
    wchar_t project_root[32768];
    wchar_t node_modules_path[32768];
    wchar_t release_app_dir[32768];
    wchar_t release_electron_path[32768];
    wchar_t release_node_path[32768];
    wchar_t release_main_path[32768];
    wchar_t system_dir[MAX_PATH];
    wchar_t cmd_path[MAX_PATH];
    wchar_t process_command[32768];

    DWORD len = GetModuleFileNameW(NULL, exe_path, (DWORD)(sizeof(exe_path) / sizeof(exe_path[0])));
    if (len == 0 || len >= (DWORD)(sizeof(exe_path) / sizeof(exe_path[0]))) {
        show_message(APP_TITLE L" エラー", L"実行ファイルの場所を取得できませんでした。", MB_ICONERROR);
        return 1;
    }

    wcscpy(exe_dir, exe_path);
    if (!remove_last_path_component(exe_dir)) {
        show_message(APP_TITLE L" エラー", L"実行フォルダを解決できませんでした。", MB_ICONERROR);
        return 1;
    }

    SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", NULL);

    if (!join_path(release_app_dir, sizeof(release_app_dir) / sizeof(release_app_dir[0]), exe_dir, L"app") ||
        !join_path(release_electron_path, sizeof(release_electron_path) / sizeof(release_electron_path[0]), exe_dir, L"runtime\\electron\\electron.exe") ||
        !join_path(release_node_path, sizeof(release_node_path) / sizeof(release_node_path[0]), exe_dir, L"runtime\\node\\node.exe") ||
        !join_path(release_main_path, sizeof(release_main_path) / sizeof(release_main_path[0]), release_app_dir, L"dist\\src\\gui\\main.js")) {
        show_message(APP_TITLE L" エラー", L"リリース版のパスが長すぎます。", MB_ICONERROR);
        return 1;
    }

    if (is_directory(release_app_dir) && is_file(release_electron_path) && is_file(release_main_path)) {
        SetEnvironmentVariableW(L"MIMI_OCR_PROJECT_ROOT", release_app_dir);
        SetEnvironmentVariableW(L"MIMI_OCR_RELEASE", L"1");
        if (is_file(release_node_path)) {
            SetEnvironmentVariableW(L"MIMI_OCR_NODE", release_node_path);
        } else {
            SetEnvironmentVariableW(L"MIMI_OCR_NODE", release_electron_path);
        }

        if (swprintf(
                process_command,
                sizeof(process_command) / sizeof(process_command[0]),
                L"\"%ls\" \"%ls\"",
                release_electron_path,
                release_app_dir
            ) <= 0) {
            show_message(APP_TITLE L" エラー", L"起動コマンドを組み立てられませんでした。", MB_ICONERROR);
            return 1;
        }

        STARTUPINFOW release_startup_info;
        PROCESS_INFORMATION release_process_info;
        ZeroMemory(&release_startup_info, sizeof(release_startup_info));
        ZeroMemory(&release_process_info, sizeof(release_process_info));
        release_startup_info.cb = sizeof(release_startup_info);
        release_startup_info.dwFlags = STARTF_USESHOWWINDOW;
        release_startup_info.wShowWindow = SW_SHOWNORMAL;

        BOOL release_ok = CreateProcessW(
            NULL,
            process_command,
            NULL,
            NULL,
            FALSE,
            0,
            NULL,
            release_app_dir,
            &release_startup_info,
            &release_process_info
        );

        if (!release_ok) {
            wchar_t message[1024];
            swprintf(
                message,
                sizeof(message) / sizeof(message[0]),
                L"同梱 Electron の起動に失敗しました。\n\n"
                L"リリースパッケージを展開し直してください。\n\n"
                L"Win32 エラー: %lu",
                GetLastError()
            );
            show_message(APP_TITLE L" エラー", message, MB_ICONERROR);
            return 1;
        }

        CloseHandle(release_process_info.hThread);
        CloseHandle(release_process_info.hProcess);
        return 0;
    }

    wcscpy(project_root, exe_dir);
    if (!remove_last_path_component(project_root)) {
        show_message(APP_TITLE L" エラー", L"プロジェクトフォルダを解決できませんでした。", MB_ICONERROR);
        return 1;
    }

    if (!join_path(node_modules_path, sizeof(node_modules_path) / sizeof(node_modules_path[0]), project_root, L"node_modules")) {
        show_message(APP_TITLE L" エラー", L"node_modules のパスが長すぎます。", MB_ICONERROR);
        return 1;
    }

    if (!is_directory(node_modules_path)) {
        wchar_t message[32768];
        swprintf(
            message,
            sizeof(message) / sizeof(message[0]),
            L"node_modules が見つかりません。\n"
            L"初回起動前にプロジェクトフォルダで以下を実行してください:\n\n"
            L"    npm install\n\n"
            L"プロジェクトフォルダ:\n%ls",
            project_root
        );
        show_message(APP_TITLE L" - セットアップが必要です", message, MB_ICONWARNING);
        return 1;
    }

    UINT system_dir_len = GetSystemDirectoryW(system_dir, sizeof(system_dir) / sizeof(system_dir[0]));
    if (system_dir_len == 0 || system_dir_len >= sizeof(system_dir) / sizeof(system_dir[0])) {
        wcscpy(cmd_path, L"cmd.exe");
    } else if (!join_path(cmd_path, sizeof(cmd_path) / sizeof(cmd_path[0]), system_dir, L"cmd.exe")) {
        wcscpy(cmd_path, L"cmd.exe");
    }

    if (swprintf(
            process_command,
            sizeof(process_command) / sizeof(process_command[0]),
            L"\"%ls\" /c npm run gui",
            cmd_path
        ) <= 0) {
        show_message(APP_TITLE L" エラー", L"起動コマンドを組み立てられませんでした。", MB_ICONERROR);
        return 1;
    }

    STARTUPINFOW startup_info;
    PROCESS_INFORMATION process_info;
    ZeroMemory(&startup_info, sizeof(startup_info));
    ZeroMemory(&process_info, sizeof(process_info));
    startup_info.cb = sizeof(startup_info);
    startup_info.dwFlags = STARTF_USESHOWWINDOW;
    startup_info.wShowWindow = SW_HIDE;

    BOOL ok = CreateProcessW(
        NULL,
        process_command,
        NULL,
        NULL,
        FALSE,
        CREATE_NO_WINDOW,
        NULL,
        project_root,
        &startup_info,
        &process_info
    );

    if (!ok) {
        wchar_t message[1024];
        swprintf(
            message,
            sizeof(message) / sizeof(message[0]),
            L"起動に失敗しました。\n\n"
            L"npm と node がインストールされているか確認してください。\n\n"
            L"Win32 エラー: %lu",
            GetLastError()
        );
        show_message(APP_TITLE L" エラー", message, MB_ICONERROR);
        return 1;
    }

    CloseHandle(process_info.hThread);
    CloseHandle(process_info.hProcess);
    return 0;
}
