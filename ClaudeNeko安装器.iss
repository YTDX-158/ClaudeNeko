; =====================================================
; ClaudeNeko 安装器（Inno Setup 6）· v0.1
; 全中文向导 + 桌面快捷方式 + 安装后可选立即启动 + 端口检测提示
; 编译：ISCC.exe "ClaudeNeko安装器.iss"
; 打包源：installer_src\（绿色版内容，编译前复制好，排除 data/media/log）
; =====================================================

#define AppName "ClaudeNeko"
#define AppVersion "2.4.3"
#define AppExeName "启动ClaudeNeko.bat"

[Setup]
AppId={{A07B4C3D-2E1F-4A56-9B87-0123456789AB}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=ClaudeNeko
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=dist_installer
OutputBaseFilename=ClaudeNeko安装器_v{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
; 全中文向导（用 ChineseSimplified.isl，界面按钮/进度/错误全中文）
ShowLanguageDialog=no
; ===== 图标美化（9-02 粒子小猫）=====
SetupIconFile=assets\图标素材\ClaudeNeko_setup.ico
UninstallDisplayIcon={app}\ClaudeNeko.ico
WizardImageFile=assets\图标素材\ClaudeNeko_installer_banner_vanilla_164x314.png
WizardSmallImageFile=assets\图标素材\ClaudeNeko_installer_small_vanilla_55x58.png

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "installer_src\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 图标素材（粒子小猫）：随安装装上，供快捷方式/卸载引用
Source: "assets\图标素材\ClaudeNeko.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNeko.ico"
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNeko.ico"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "立即启动 ClaudeNeko"; Flags: nowait postinstall skipifsilent

[Code]
// 端口检测（排雷）：安装完成后若 4000 被占，提示用户（避免"新份起不来还以为是坏了"）
function IsPort4000InUse(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec('powershell',
    '-NoProfile -Command "try{$c=Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue; if($c){exit 1}}catch{}; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 1);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if IsPort4000InUse() then
      MsgBox('检测到 4000 端口已被占用（可能有另一个 ClaudeNeko 正在运行）。' + #13#10 +
             '如果启动后打不开，请先退出旧的那个 ClaudeNeko 再重新启动。',
             mbInformation, MB_OK);
end;
