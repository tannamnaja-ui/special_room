; Special Room System - Offline Full Installer
; Bundles a pkg-compiled, self-contained Node.js server (no Node.js install needed)
; plus a hidden-window C# launcher (no console window shown to the user).

#define MyAppName "Special Room System"
#define MyAppVersion "1.1.0"
#define MyAppPublisher "Hospital Private Room System"
#define MyAppExeName "Launcher.exe"

[Setup]
AppId={{6C8F0B2E-6F1E-4E8B-9B8A-2B8F6D3B7E10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\SpecialRoomSystem
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Special_room-system-Setup-Full
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableWelcomePage=no
ArchitecturesInstallIn64BitMode=x64

[Languages]
Name: "thai"; MessagesFile: "compiler:Languages\Thai.isl"

[Files]
Source: "Launcher.exe"; DestDir: "{app}"; Flags: ignoreversion restartreplace
Source: "..\build\server\special_room-server.exe"; DestDir: "{app}\server"; Flags: ignoreversion restartreplace
; ตัวติดตั้ง .NET Framework 4.8 แบบ offline — แตกลง {tmp} เฉพาะตอนที่เครื่องปลายทางยังไม่มี .NET 4.8
; (Windows 10 1903 ขึ้นไปและ Windows 11 มีมาให้อยู่แล้ว จึงมักถูกข้ามไป ไม่เสียเวลาแตกไฟล์)
Source: "..\prereq\ndp48-offline.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsDotNet48

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"

[Run]
; ติดตั้ง .NET Framework 4.8 จากไฟล์ที่แนบมาในตัว setup (ไม่ต้องต่ออินเทอร์เน็ต)
; ข้ามอัตโนมัติถ้าเครื่องมี .NET 4.8 อยู่แล้ว — shellexec เพื่อให้ Windows ขอสิทธิ์ผู้ดูแลระบบให้เอง
Filename: "{tmp}\ndp48-offline.exe"; Parameters: "/q /norestart"; \
  StatusMsg: "กำลังติดตั้ง .NET Framework 4.8 (จำเป็นต้องใช้ครั้งเดียว)..."; \
  Check: NeedsDotNet48; Flags: shellexec waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "เปิดใช้งาน {#MyAppName}"; Flags: nowait postinstall

[Code]
var
  g_HasConfigBackup: Boolean;
  g_ConfigBackupPath: String;

// ตรวจว่าเครื่องมี .NET Framework 4.8 แล้วหรือยัง (Launcher.exe ต้องใช้)
// ค่า Release ในรีจิสทรี: 528040 ขึ้นไป = 4.8 หรือใหม่กว่า
// คืน True เมื่อ "ยังไม่มี" เท่านั้น — ถ้ามีอยู่แล้วจะข้ามการติดตั้งตัวนี้ไปเลย
function NeedsDotNet48(): Boolean;
var
  release: Cardinal;
begin
  Result := True;
  if RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', release) then
    if release >= 528040 then
      Result := False;
end;

// ลบ/ถอนการติดตั้งเวอร์ชันเดิมแบบเงียบก่อนติดตั้งเวอร์ชันใหม่ (ตรวจจากรีจิสทรีของ AppId เดียวกัน)
function GetUninstallString(): String;
var
  sUnInstPath: String;
  sUnInstallString: String;
begin
  sUnInstPath := 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting("AppId")}_is1';
  sUnInstallString := '';
  if not RegQueryStringValue(HKCU, sUnInstPath, 'UninstallString', sUnInstallString) then
    RegQueryStringValue(HKLM, sUnInstPath, 'UninstallString', sUnInstallString);
  Result := sUnInstallString;
end;

procedure KillServerIfRunning();
var
  ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /IM special_room-server.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /IM Launcher.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function InitializeSetup(): Boolean;
var
  sUnInstallString: String;
  iResultCode: Integer;
  sOldInstallDir: String;
  sOldConfigFile: String;
begin
  Result := True;
  KillServerIfRunning();

  // รัน uninstaller ของเวอร์ชันเดิม (ถ้ามี) แบบเงียบก่อน
  sUnInstallString := GetUninstallString();
  if sUnInstallString <> '' then
  begin
    sUnInstallString := RemoveQuotes(sUnInstallString);
    Exec(sUnInstallString, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, iResultCode);
  end;

  sOldInstallDir := ExpandConstant('{localappdata}\SpecialRoomSystem');
  sOldConfigFile := sOldInstallDir + '\server\config\connection.json';

  // สำรองค่าเชื่อมต่อ DB เดิมไว้ก่อนลบทั้งโฟลเดอร์ จะได้คืนกลับมาให้หลังติดตั้งเวอร์ชันใหม่เสร็จ
  g_HasConfigBackup := False;
  if FileExists(sOldConfigFile) then
  begin
    g_ConfigBackupPath := ExpandConstant('{tmp}\connection.json.bak');
    g_HasConfigBackup := CopyFile(sOldConfigFile, g_ConfigBackupPath, False);
  end;

  // ลบโฟลเดอร์ติดตั้งเดิมทั้งหมดให้เกลี้ยง (รวมไฟล์ที่โปรแกรมสร้างเพิ่มตอนใช้งาน เช่น logs
  // ที่ uninstaller มาตรฐานจะไม่ลบให้ เพราะไม่ได้เป็นไฟล์ที่ตัว installer เดิมติดตั้งไว้)
  if DirExists(sOldInstallDir) then
    DelTree(sOldInstallDir, True, True, True);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  sNewConfigDir: String;
begin
  if (CurStep = ssPostInstall) and g_HasConfigBackup then
  begin
    sNewConfigDir := ExpandConstant('{app}\server\config');
    if not DirExists(sNewConfigDir) then
      ForceDirectories(sNewConfigDir);
    CopyFile(g_ConfigBackupPath, sNewConfigDir + '\connection.json', False);
  end;
end;
