; =====================================================
; ClaudeNeko 安装器（Inno Setup 6）· v2.4.12
; 全中文向导 + 桌面快捷方式 + 安装后可选立即启动
; v2.4.8（9-05）：目录页可选(DisableDirPage=no) + 装前关进程拦截(A7)
;   + 目录可写校验(A9) + 换目录数据自动迁移(server\data+media)(A1-A10) + 计划任务重指向(A12)
; 编译：ISCC.exe "ClaudeNeko安装器.iss"
; 打包源：installer_src\（绿色版内容，编译前复制好，排除 server\data\media\log）
; =====================================================

#define AppName "ClaudeNeko"
#define AppVersion "2.4.12"
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
; 强制显示"选择安装位置"页——Inno 默认 auto 在覆盖/低权限场景会吞目录页（9-05 朋友反馈·v2.4.8 修）
DisableDirPage=no
; 免管理员（装 localappdata）→ 用户无 UAC 弹窗
PrivilegesRequired=lowest
OutputDir=dist_installer
OutputBaseFilename=ClaudeNeko安装器_v{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; 全中文向导
ShowLanguageDialog=no
; ===== 图标美化（粒子小猫）=====
SetupIconFile=assets\图标素材\ClaudeNeko_setup.ico
UninstallDisplayIcon={app}\ClaudeNeko.ico
WizardImageFile=assets\图标素材\ClaudeNeko_installer_banner_vanilla_164x314.png
WizardSmallImageFile=assets\图标素材\ClaudeNeko_installer_small_vanilla_55x58.png

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

; ===== 数据迁移任务（换目录时默认勾选；全新装/同目录升级自动隐藏）=====
[Tasks]
Name: migrateData; Description: 把旧版本的数据（聊天记录 + 媒体库）复制到新位置; Check: ShouldShowMigrateTask

[Files]
Source: "installer_src\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; 图标素材：随安装装上，供快捷方式/卸载引用
Source: "assets\图标素材\ClaudeNeko.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNeko.ico"
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\ClaudeNeko.ico"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "立即启动 ClaudeNeko"; Flags: nowait postinstall skipifsilent

[Code]
// ============ 常量 ============
const
  NEKO_APP_ID = '{A07B4C3D-2E1F-4A56-9B87-0123456789AB}_is1';
  UNINST_KEY  = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\';
  NEKO_PORT   = 4000;   // ClaudeNeko server 监听端口（运行中唯一精准信号）

// ============ 端口 / 进程（A7） ============
// 4000 端口是否被监听（= ClaudeNeko 在运行）
function IsPortInUse(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if Exec('powershell',
    '-NoProfile -Command "try{$c=Get-NetTCPConnection -LocalPort '+IntToStr(NEKO_PORT)+
    ' -State Listen -ErrorAction SilentlyContinue; if($c){exit 1}}catch{}; exit 0"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    Result := (ResultCode = 1);
end;

// 用 netstat 找 4000 的 LISTENING 进程 PID（精准，不误伤其他 node）
// 实现：netstat 落盘 → Pascal 逐行找 :4000 + LISTENING → 取行尾 PID
//      （不用 cmd 管道/重定向双引号嵌套，避免 shell 解析坑）
function GetPortPid(): String;
var
  ResultCode: Integer; tmp: String; lines: TArrayOfString;
  i, q: Integer; line, pid: String;
begin
  Result := '';
  tmp := ExpandConstant('{tmp}')+'\neko_net.txt';
  DeleteFile(tmp);
  if not Exec('cmd.exe', '/c netstat -ano > "' + tmp + '"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then exit;
  if not LoadStringsFromFile(tmp, lines) then exit;
  DeleteFile(tmp);
  // 逐行：含 :4000 且含 LISTENING → 取该行最后一个非空段 = PID
  for i := 0 to GetArrayLength(lines) - 1 do begin
    line := Trim(lines[i]);
    if (Pos(':' + IntToStr(NEKO_PORT), line) > 0) and (Pos('LISTENING', line) > 0) then begin
      q := Length(line);
      while (q > 0) and (line[q] <> ' ') do Dec(q);
      pid := Trim(Copy(line, q + 1, Length(line) - q));
      if pid <> '' then Result := pid;
    end;
  end;
end;

// 结束指定进程（含子进程树）
function KillProcess(pid: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('taskkill', '/PID ' + pid + ' /F /T', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// ============ 旧安装目录检测（A1 / A5） ============
// 返回上一版 ClaudeNeko 安装目录（'' = 无旧装）
//  ① 卸载键 InstallLocation（最新最准） ② 兜底默认 {localappdata}\ClaudeNeko
// 都需通过"特征校验"才算真 ClaudeNeko 旧装（防误迁无关目录）
// ⚠ edge case(已知)：若用户"先卸载旧版→再装新目录"，卸载会删卸载键+程序文件
//   → 检测不到旧 server\data\media 残留 → 迁移不触发。正常"升级装换目录"路径无此问题。
function GetPreviousAppDir(): String;
var
  s, defaultDir: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, UNINST_KEY + NEKO_APP_ID, 'InstallLocation', s) then
    if FileExists(s + '\server\server.js') then begin
      Result := s;
      exit;
    end;
  defaultDir := ExpandConstant('{localappdata}\ClaudeNeko');
  if FileExists(defaultDir + '\server\server.js') then
    Result := defaultDir;
end;

// [Tasks] Check：换目录 + 旧目录有真实数据才显示迁移任务
function ShouldShowMigrateTask(): Boolean;
var
  oldDir: String;
begin
  Result := False;
  oldDir := GetPreviousAppDir;
  if oldDir = '' then exit;                                // 无旧装
  if CompareText(oldDir, WizardDirValue) = 0 then exit;    // 同目录升级不用迁
  if not DirExists(oldDir + '\server\data') and
     not DirExists(oldDir + '\server\media') then exit;    // 旧目录没有要迁的数据
  Result := True;
end;

// ============ 目录可写校验（A9） ============
function DirWritable(dir: String): Boolean;
var
  testFile: String;
begin
  Result := False;
  testFile := dir + '\_neko_wr_test.tmp';
  if SaveStringToFile(testFile, 't', False) then begin
    DeleteFile(testFile);
    Result := True;
  end;
end;

// 用户点"下一步"时拦截：
//   wpSelectDir → 校验所选目录可写（A9；目标可能还不存在→向上找存在的父目录测）
//   wpReady    → 若 ClaudeNeko 正在运行（占 4000）→ 自动关闭或中止（A7）
function NextButtonClick(CurPageID: Integer): Boolean;
var
  dir, pid: String; r: Integer;
begin
  Result := True;
  if CurPageID = wpSelectDir then begin
    dir := WizardDirValue;
    while (Length(dir) > 3) and not DirExists(dir) do
      dir := ExtractFileDir(dir);
    if not DirWritable(dir) then begin
      MsgBox('所选位置需要管理员权限才能写入。' + #13#10 + #13#10 +
        '请选一个普通文件夹（如 D:\ClaudeNeko），或直接用默认位置。',
        mbError, MB_OK);
      Result := False;
    end;
  end else if CurPageID = wpReady then begin
    if IsPortInUse then begin
      r := MsgBox('检测到 ClaudeNeko 正在运行（占用 4000 端口）。' + #13#10 + #13#10 +
        '安装 / 迁移前需要先关闭它，否则可能安装失败或数据冲突。' + #13#10 +
        '是否自动关闭后继续？（选「否」将取消安装）',
        mbConfirmation, MB_YESNO);
      if r = IDYES then begin
        pid := GetPortPid;
        if pid <> '' then KillProcess(pid);
        if IsPortInUse then begin
          MsgBox('未能自动关闭 ClaudeNeko，请手动结束它后再运行安装。', mbError, MB_OK);
          Result := False;
        end;
      end else
        Result := False;
    end;
  end;
end;

// ============ 数据迁移执行（A3 / A4） ============
// robocopy 镜像复制一个目录；返回 True=成功（robocopy 0-7 成功,>=8 失败）
function RoboCopyDir(src, dst: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := Exec('robocopy', '"' + src + '" "' + dst + '" /E /NFL /NDL /NJH /NJS /R:1 /W:1',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Result then Result := (ResultCode < 8);
end;

// 迁移旧安装的 server\data + server\media 到新目录
procedure MigrateData(oldDir, newDir: String);
var
  okData, okMedia: Boolean;
begin
  okData := False;
  okMedia := False;
  WizardForm.StatusLabel.Caption := '正在迁移旧数据（聊天记录 + 媒体库），请稍候…';
  if DirExists(oldDir + '\server\data') then
    okData := RoboCopyDir(oldDir + '\server\data', newDir + '\server\data');
  if DirExists(oldDir + '\server\media') then
    okMedia := RoboCopyDir(oldDir + '\server\media', newDir + '\server\media');
  if okData or okMedia then
    MsgBox('旧数据已复制到新位置。' + #13#10 + #13#10 +
      '确认 ClaudeNeko 正常后，可手动删除旧文件夹释放空间：' + #13#10 + oldDir,
      mbInformation, MB_OK)
  else
    MsgBox('数据迁移未完成（可能旧目录为空或已被占用）。' + #13#10 +
      '可稍后手动复制旧目录里的 server\data 和 server\media 到新位置。',
      mbInformation, MB_OK);
end;

// ============ 装后：迁移数据 + 清理旧自启任务（A12 / A8） ============
procedure CurStepChanged(CurStep: TSetupStep);
var
  oldDir, newDir: String; rc: Integer;
begin
  if CurStep = ssPostInstall then begin
    // A12：删旧自启计划任务（指向旧路径）——新目录首启若开自启会自注册新路径
    Exec('schtasks', '/Delete /TN ClaudeNekoServer /F', '', SW_HIDE, ewWaitUntilTerminated, rc);
    // 迁移（仅当任务被勾选 且 确实换了目录）
    if WizardIsTaskSelected('migrateData') then begin
      oldDir := GetPreviousAppDir;
      newDir := ExpandConstant('{app}');
      if (oldDir <> '') and (CompareText(oldDir, newDir) <> 0) then
        MigrateData(oldDir, newDir);
    end;
  end;
end;
