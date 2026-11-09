; Zinc (GPUI) installer: Inno Setup 7. Built by scripts/installer.ts, which passes these defines on the ISCC command line:
;   AppVer      full build stamp, "0.1.0+<commit>-<yyyymmdd>" (Apps & features shows it)
;   NumVer      "0.1.<n>.0" for the exe's version resource
;   Publisher   Apps & features publisher
;   PkgDir      the packaged app folder (bun gpui-ui/scripts/package.ts --aot)
;   StampFile   a one-line version.txt holding the build stamp, installed as {app}\version.txt
;   IconFile    gpui-ui/assets/icon.ico
;   WordDir     staging folder with addin\ (word/build.ps1 -OutDir); leave out for an installer without the Word add-in
;   WordScripts word\ folder holding install.ps1 and uninstall.ps1
;   ConnDir     staging folder with zotero-next-host.exe, install.ps1, uninstall.ps1, connector-howto.html and extension\ (the browser
;               connector); leave out for an installer without it
;   OutDir, OutName   where the setup .exe goes, and its name without ".exe"
;   Signed      defined when a certificate is configured: ISCC then runs the "znsign" hook (scripts/sign.ts) on the setup and the uninstaller
;   TestMode    a different AppId and name ("Zinc (installer test)"), so a test run never touches a real install
;
; Per user, no admin: {userpf}\Zinc = %LOCALAPPDATA%\Programs\Zinc, HKCU only, Start-menu shortcut (+ optional desktop one).
; Never touched by install, upgrade or uninstall: %APPDATA%\zotero-next*, the library, logs, settings (only the optional "also remove
; settings and logs" answer at uninstall removes settings and logs, never *.sqlite files).
;
; Command line (Inno's own switches plus ours):
;   /VERYSILENT /SUPPRESSMSGBOXES /NORESTART [/DIR="..."] [/COMPONENTS="app"|"app,word,connector"] [/TASKS="desktopicon"] [/LOG="file"]
;   /ZNTESTHIVE="file"   register the Word add-in into a private registry hive file instead of HKCU (tests; also skips the Word-running check)
;   /ZNRELAUNCH          start the app after a silent install (what the updater passes; interactive runs offer "Start Zinc" instead)
;   /ZNAPPDATA="dir"     use this folder instead of %APPDATA% for "remove settings" (tests)
;   uninstaller: /VERYSILENT [/REMOVEDATA]   /REMOVEDATA also removes settings and logs (silent runs keep them otherwise)

#ifndef AppVer
  #error AppVer is required (run bun gpui-ui/scripts/installer.ts)
#endif

#ifdef TestMode
  #define AppName "Zinc (installer test)"
  #define AppDirName "Zinc (installer test)"
  ; own native-messaging host name: a test run registers and removes only this one, never the real com.zotero_next.connector_host
  #define ConnHostName "com.zotero_next.connector_host_test"
#else
  #define AppName "Zinc"
  #define AppDirName "Zinc"
  #define ConnHostName "com.zotero_next.connector_host"
#endif

[Setup]
#ifdef TestMode
AppId={{5B1E8F34-92D6-4A0C-8E7B-60C3D14F9A28}
#else
AppId={{C4D2B7A0-5E31-4F68-9A1B-3D8E6F20A5C7}
#endif
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher={#Publisher}
VersionInfoVersion={#NumVer}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} setup
VersionInfoCompany={#Publisher}
DefaultDirName={userpf}\{#AppDirName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; a 64-bit Setup and uninstaller (Inno Setup 7): everything they start, PowerShell for the Word add-in included, is 64-bit like the
; app and like Word, so COM registration lands in the registry view Word reads
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\icon.ico
UninstallDisplayName={#AppName}
OutputDir={#OutDir}
OutputBaseFilename={#OutName}
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no
RestartIfNeededByRun=no
#ifdef Signed
SignTool=znsign
SignedUninstaller=yes
#endif

[Types]
Name: "full"; Description: "Full installation"
Name: "app"; Description: "Application only"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "app"; Description: "Zinc"; Types: full app custom; Flags: fixed
#ifdef WordDir
Name: "word"; Description: "Microsoft Word add-in (cite from your library inside Word)"; Types: full custom
#endif
#ifdef ConnDir
Name: "connector"; Description: "Browser connector (save from Chrome/Edge without the app open)"; Types: full custom
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; Flags: unchecked

[InstallDelete]
; upgrade in place: drop the program folders this installer owns before the new copies go in, so files removed between versions do not linger
Type: filesandordirs; Name: "{app}\vendor"; Components: app
Type: filesandordirs; Name: "{app}\reader-host"; Components: app
Type: filesandordirs; Name: "{app}\note-host"; Components: app
Type: filesandordirs; Name: "{app}\pdfium-licenses"; Components: app
#ifndef TestMode
; the product was called "Zotero Next" before the rename to Zinc: an in-place upgrade removes the old shortcuts so only the Zinc ones remain
Type: files; Name: "{userprograms}\Zotero Next.lnk"
Type: files; Name: "{userdesktop}\Zotero Next.lnk"
Type: files; Name: "{userprograms}\Zotero Next Connector - how to install.lnk"
#endif
#ifdef WordDir
Type: filesandordirs; Name: "{app}\word"; Components: word; Check: AddinFilesAllowed
#endif
#ifdef ConnDir
; the extension folder is Chrome's to write into (_metadata) once loaded: replace it wholesale
Type: filesandordirs; Name: "{app}\connector\extension"; Components: connector
#endif

[Files]
Source: "{#PkgDir}\*"; DestDir: "{app}"; Components: app; Excludes: "version.txt"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StampFile}"; DestDir: "{app}"; Components: app; Flags: ignoreversion
#ifdef WordDir
Source: "{#WordDir}\addin\*"; DestDir: "{app}\word\addin"; Components: word; Check: AddinFilesAllowed; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WordScripts}\install.ps1"; DestDir: "{app}\word"; Components: word; Check: AddinFilesAllowed; Flags: ignoreversion
Source: "{#WordScripts}\uninstall.ps1"; DestDir: "{app}\word"; Components: word; Check: AddinFilesAllowed; Flags: ignoreversion
#endif
#ifdef ConnDir
Source: "{#ConnDir}\zotero-next-host.exe"; DestDir: "{app}\connector"; Components: connector; Flags: ignoreversion
Source: "{#ConnDir}\install.ps1"; DestDir: "{app}\connector"; Components: connector; Flags: ignoreversion
Source: "{#ConnDir}\uninstall.ps1"; DestDir: "{app}\connector"; Components: connector; Flags: ignoreversion
Source: "{#ConnDir}\connector-howto.html"; DestDir: "{app}\connector"; Components: connector; Flags: ignoreversion
Source: "{#ConnDir}\extension\*"; DestDir: "{app}\connector\extension"; Components: connector; Flags: ignoreversion recursesubdirs createallsubdirs
#endif

[UninstallDelete]
; the generated host manifest, and whatever Chrome wrote into the extension folder (_metadata)
Type: filesandordirs; Name: "{app}\connector"

[Icons]
Name: "{userprograms}\{#AppName}"; Filename: "{app}\zotero-next-gpui.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Your reference library"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\zotero-next-gpui.exe"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon
#ifdef ConnDir
Name: "{userprograms}\{#AppName} Connector - how to install"; Filename: "{app}\connector\connector-howto.html"; IconFilename: "{app}\icon.ico"; Comment: "Add the browser extension to Chrome or Edge"; Components: connector
#endif

[Run]
Filename: "{app}\zotero-next-gpui.exe"; Description: "Start Zinc"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent
#ifdef ConnDir
Filename: "{app}\connector\connector-howto.html"; Description: "Show how to add the browser extension to Chrome or Edge"; Components: connector; Flags: shellexec nowait postinstall skipifsilent
#endif
; the updater (silent upgrade) asks for the app to come back with /ZNRELAUNCH
Filename: "{app}\zotero-next-gpui.exe"; WorkingDir: "{app}"; Flags: nowait; Check: CmdLineParamExists('/ZNRELAUNCH')

[Code]
type
  TIntArray = array of Integer;

var
  WordSkipped: Boolean;     // Word is open and (silent run, or the user chose to skip): leave the add-in as it is this time
  RemoveSettings: Boolean;  // uninstall: also remove settings and logs

// ---- helpers ------------------------------------------------------------------------------------------------------------------

// /NAME=value -> value, /NAME -> '1', else ''. Works in the installer and the uninstaller.
function GetParam(const Name: string): string;
var
  i: Integer;
  S, P: string;
begin
  Result := '';
  P := '/' + Uppercase(Name);
  for i := 1 to ParamCount do
  begin
    S := ParamStr(i);
    if CompareText(Copy(S, 1, Length(P) + 1), P + '=') = 0 then begin Result := Copy(S, Length(P) + 2, MaxInt); Exit; end;
    if CompareText(S, P) = 0 then begin Result := '1'; Exit; end;
  end;
end;

// True when the switch (e.g. '/ZNRELAUNCH') is on the command line.
function CmdLineParamExists(const Name: string): Boolean;
begin
  Result := GetParam(Copy(Name, 2, MaxInt)) <> '';
  Log('CmdLineParamExists(' + Name + ') = ' + IntToStr(Ord(Result)));
end;

function IsSilentRun: Boolean;
begin
  if IsUninstaller then Result := UninstallSilent else Result := WizardSilent;
end;

// Process ids of ExeName; with UnderDir set, only those running from a file below that folder (a real install elsewhere is not ours).
function FindProcesses(const ExeName, UnderDir: string): TIntArray;
var
  Loc, Svc, Res, Obj, Pth: Variant;
  i, n, k: Integer;
  Path: string;
begin
  SetArrayLength(Result, 0);
  try
    Loc := CreateOleObject('WbemScripting.SWbemLocator');
    Svc := Loc.ConnectServer('.', 'root\cimv2');
    Res := Svc.ExecQuery('SELECT ProcessId, ExecutablePath FROM Win32_Process WHERE Name = ''' + ExeName + '''');
    n := Res.Count;
    for i := 0 to n - 1 do
    begin
      Obj := Res.ItemIndex(i);
      Pth := Obj.ExecutablePath;
      if VarIsNull(Pth) or VarIsEmpty(Pth) then Path := '' else Path := Pth;
      if (UnderDir = '') or (Pos(Lowercase(UnderDir) + '\', Lowercase(Path)) = 1) then
      begin
        k := GetArrayLength(Result);
        SetArrayLength(Result, k + 1);
        Result[k] := Obj.ProcessId;
      end;
    end;
  except
    Log('process query failed: ' + GetExceptionMessage);
  end;
end;

function AppRunning(const Dir: string): Boolean;
begin
  Result := GetArrayLength(FindProcesses('zotero-next-gpui.exe', Dir)) > 0;
end;

function WordRunning: Boolean;
begin
  Result := GetArrayLength(FindProcesses('WINWORD.EXE', '')) > 0;
end;

// Ask the app's windows to close (taskkill without /F = WM_CLOSE), wait up to 15 s.
procedure CloseAppGracefully(const Dir: string);
var
  Pids: TIntArray;
  i, rc, waited: Integer;
begin
  Pids := FindProcesses('zotero-next-gpui.exe', Dir);
  for i := 0 to GetArrayLength(Pids) - 1 do
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/PID ' + IntToStr(Pids[i]), '', SW_HIDE, ewWaitUntilTerminated, rc);
  waited := 0;
  while AppRunning(Dir) and (waited < 15000) do begin Sleep(500); waited := waited + 500; end;
end;

// Returns '' when the app is not running (any more), else a message that aborts the install/uninstall.
function EnsureAppClosed(const Dir: string): string;
begin
  Result := '';
  while AppRunning(Dir) do
  begin
    if IsSilentRun then
    begin
      CloseAppGracefully(Dir);
      if AppRunning(Dir) then Result := 'Zinc is running and did not close. Close it and run this again.';
      Exit;
    end;
    if MsgBox('Zinc is running.' + #13#10#13#10 + 'Click OK to close it now (or close it yourself first), Cancel to stop.', mbConfirmation, MB_OKCANCEL) <> IDOK then
    begin
      Result := 'Zinc is running. Close it and run this again.';
      Exit;
    end;
    CloseAppGracefully(Dir);
  end;
end;

function TestHive: string;
begin
  Result := GetParam('ZNTESTHIVE');
end;

// Always 64-bit PowerShell: a 32-bit PowerShell's COM registration lands in HKCU\Software\Classes\WOW6432Node, which 64-bit Word
// never reads (found on the first real install, when Setup was still 32-bit). Setup is 64-bit now (SetupArchitecture=x64);
// {sys} is the real (64-bit) System32 for a 64-bit Setup; the Sysnative alias only exists for 32-bit processes, so it is used only
// when it is there (a 32-bit Setup on 64-bit Windows).
function PowerShell: string;
var Native: string;
begin
  Native := ExpandConstant('{win}\Sysnative\WindowsPowerShell\v1.0\powershell.exe');
  if FileExists(Native) then
    Result := Native
  else
    Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

// Runs a bundled add-in script under Windows PowerShell 5.1 (the CLR's COM registration only exists there). Returns the exit code.
function RunAddinScript(const Script, ExtraArgs: string): Integer;
var
  Args: string;
begin
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\word\') + Script + '" -AddinDir "' + ExpandConstant('{app}\word\addin') + '"';
  if TestHive <> '' then Args := Args + ' -TestHive "' + TestHive + '"';
  if ExtraArgs <> '' then Args := Args + ' ' + ExtraArgs;
  Log('running powershell ' + Args);
  if not Exec(PowerShell, Args, ExpandConstant('{app}\word'), SW_HIDE, ewWaitUntilTerminated, Result) then Result := -1;
  Log('exit code ' + IntToStr(Result));
end;

function AddinFilesAllowed: Boolean;
begin
  Result := not WordSkipped;
end;

// ---- browser connector ----------------------------------------------------------------------------------------------------------

// Chrome/Edge start {app}\connector\zotero-next-host.exe when the extension connects and keep it for as long as the browser runs: it
// locks the exe, so it is ended before the files are replaced or removed. This is safe: the host keeps its save sessions on disk and
// each library write is a short transaction; the extension starts a new host on its next call. Only hosts running from {app}.
procedure StopConnectorHosts(const Dir: string);
var
  Pids: TIntArray;
  i, rc: Integer;
begin
  Pids := FindProcesses('zotero-next-host.exe', Dir + '\connector');
  for i := 0 to GetArrayLength(Pids) - 1 do
  begin
    Log('ending connector host process ' + IntToStr(Pids[i]));
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /PID ' + IntToStr(Pids[i]), '', SW_HIDE, ewWaitUntilTerminated, rc);
  end;
  if GetArrayLength(Pids) > 0 then Sleep(500);
end;

// Runs install.ps1 / uninstall.ps1 from {app}\connector (the same scripts connector-host ships) with the manifest folder and host name
// this installer owns; install.ps1 also gets the installed exe. Returns the exit code.
function RunConnectorScript(const Script: string): Integer;
var
  Dir, Args: string;
begin
  Dir := ExpandConstant('{app}\connector');
  Args := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + Dir + '\' + Script + '" -ManifestDir "' + Dir + '" -HostName "{#ConnHostName}"';
  if Script = 'install.ps1' then Args := Args + ' -HostExe "' + Dir + '\zotero-next-host.exe"';
  Log('running powershell ' + Args);
  if not Exec(PowerShell, Args, Dir, SW_HIDE, ewWaitUntilTerminated, Result) then Result := -1;
  Log('exit code ' + IntToStr(Result));
end;

// Word loads the add-in dll and reads its registration at start-up: it has to be closed while the add-in changes. A test hive run never
// touches Word's real registration, so it does not wait for Word.
function EnsureWordClosed(const Dir: string): Boolean;
var
  r: Integer;
begin
  Result := True; // False = abort
  if TestHive <> '' then Exit;
  while WordRunning do
  begin
    if IsSilentRun then begin WordSkipped := True; Log('Word is running: the Word add-in is left as it is'); Exit; end;
    r := MsgBox('Microsoft Word is running, and the Word add-in cannot be changed while it is open.' + #13#10#13#10 +
                'Close Word, then click Yes to continue.' + #13#10 + 'Click No to leave the Word add-in as it is this time, or Cancel to stop.', mbConfirmation, MB_YESNOCANCEL);
    if r = IDCANCEL then begin Result := False; Exit; end;
    if r = IDNO then begin WordSkipped := True; Exit; end;
  end;
end;

// ---- install ------------------------------------------------------------------------------------------------------------------

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Dir: string;
  AddinInvolved: Boolean;
begin
  Dir := ExpandConstant('{app}');
  Result := EnsureAppClosed(Dir);
  if Result <> '' then Exit;
  StopConnectorHosts(Dir);
  AddinInvolved := FileExists(Dir + '\word\uninstall.ps1');
#ifdef WordDir
  AddinInvolved := AddinInvolved or WizardIsComponentSelected('word');
#endif
  if AddinInvolved and (not EnsureWordClosed(Dir)) then Result := 'Setup stopped: Microsoft Word is open.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  rc: Integer;
  Selected, ConnSelected: Boolean;
begin
  Selected := False;
  ConnSelected := False;
#ifdef WordDir
  Selected := WizardIsComponentSelected('word');
#endif
#ifdef ConnDir
  ConnSelected := WizardIsComponentSelected('connector');
#endif
  if CurStep = ssInstall then
  begin
    // upgrade where the browser connector was unticked: unregister it and remove its files
    if (not ConnSelected) and FileExists(ExpandConstant('{app}\connector\uninstall.ps1')) then
    begin
      WizardForm.StatusLabel.Caption := 'Removing the browser connector...';
      RunConnectorScript('uninstall.ps1');
      DelTree(ExpandConstant('{app}\connector'), True, True, True);
    end;
    // upgrade where the Word add-in was unticked: unregister it and remove its files
    if (not Selected) and (not WordSkipped) and FileExists(ExpandConstant('{app}\word\uninstall.ps1')) then
    begin
      WizardForm.StatusLabel.Caption := 'Removing the Word add-in...';
      RunAddinScript('uninstall.ps1', '');
      DelTree(ExpandConstant('{app}\word'), True, True, True);
    end;
  end;
  if (CurStep = ssPostInstall) and ConnSelected then
  begin
    WizardForm.StatusLabel.Caption := 'Registering the browser connector...';
    rc := RunConnectorScript('install.ps1');
    if rc <> 0 then
    begin
      Log('browser connector registration failed (' + IntToStr(rc) + ')');
      if not WizardSilent then
        MsgBox('Zinc is installed, but the browser connector could not be registered (exit code ' + IntToStr(rc) + ').' + #13#10 +
               'You can try again with: powershell -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\connector\install.ps1') + '" -ManifestDir "' + ExpandConstant('{app}\connector') + '"', mbError, MB_OK);
    end;
  end;
  if (CurStep = ssPostInstall) and Selected and (not WordSkipped) then
  begin
    WizardForm.StatusLabel.Caption := 'Registering the Word add-in...';
    rc := RunAddinScript('install.ps1', '');
    if rc <> 0 then
    begin
      Log('Word add-in registration failed (' + IntToStr(rc) + ')');
      if not WizardSilent then
        MsgBox('Zinc is installed, but the Word add-in could not be registered (exit code ' + IntToStr(rc) + ').' + #13#10 +
               'You can try again with: powershell -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\word\install.ps1') + '" -AddinDir "' + ExpandConstant('{app}\word\addin') + '"', mbError, MB_OK);
    end;
  end;
end;

// ---- uninstall ----------------------------------------------------------------------------------------------------------------

function InitializeUninstall(): Boolean;
var
  Msg: string;
begin
  Result := False;
  Msg := EnsureAppClosed(ExpandConstant('{app}'));
  if Msg <> '' then begin if not UninstallSilent then MsgBox(Msg, mbError, MB_OK); Exit; end;
  StopConnectorHosts(ExpandConstant('{app}'));
  if FileExists(ExpandConstant('{app}\word\uninstall.ps1')) and (not EnsureWordClosed(ExpandConstant('{app}'))) then Exit;
  if UninstallSilent then
    RemoveSettings := GetParam('REMOVEDATA') <> ''
  else
    RemoveSettings := MsgBox('Also remove your Zinc settings and logs?' + #13#10#13#10 +
                             'Your library is never removed. Choose No to keep everything (settings and logs stay if you install again).',
                             mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
  Result := True;
end;

var
  // the configured library's folder (lowercase, no trailing backslash): its files, its storage\ tree and everything below it are never touched
  ProtectedLibDir: string;
  // library.json exists but its path could not be read: every folder except logs\ is left alone rather than guessed at
  ProtectAllFolders: Boolean;

// The "path" value of a library.json {"path": "..."}; False when it cannot be read with certainty (no value, or a \u escape).
function ReadLibraryJsonPath(const Json: string; var Path: string): Boolean;
var
  I, N: Integer;
  C: Char;
begin
  Result := False;
  Path := '';
  I := Pos('"path"', Json);
  if I = 0 then Exit;
  I := I + 6;
  N := Length(Json);
  while (I <= N) and (Json[I] <> '"') and (Json[I] <> 'n') and (Json[I] <> '{') and (Json[I] <> '}') do I := I + 1;
  if (I > N) or (Json[I] <> '"') then Exit;
  I := I + 1;
  while I <= N do
  begin
    C := Json[I];
    if C = '"' then begin Result := Path <> ''; Exit; end;
    if C = '\' then
    begin
      I := I + 1;
      if I > N then Exit;
      C := Json[I];
      if C = 'u' then begin Path := ''; Exit; end;
    end;
    Path := Path + C;
    I := I + 1;
  end;
  Path := '';
end;

// Reads the saved library path from <SettingsDir>\library.json, so DeleteSettingsTree can leave that library's folder (database and storage) alone.
procedure LoadLibraryProtection(const SettingsDir: string);
var
  Json, Path: string;
  Lines: TArrayOfString;
  K: Integer;
  Loaded: Boolean;
begin
  ProtectedLibDir := '';
  ProtectAllFolders := False;
  if not FileExists(SettingsDir + '\library.json') then Exit;
  // LoadStringsFromFile reads the file as Unicode text (LoadStringFromFile only fills an AnsiString), so non-ASCII paths survive
  Loaded := LoadStringsFromFile(SettingsDir + '\library.json', Lines);
  Json := '';
  if Loaded then
    for K := 0 to GetArrayLength(Lines) - 1 do Json := Json + Lines[K] + #10;
  if (not Loaded) or (not ReadLibraryJsonPath(Json, Path)) then
  begin
    ProtectAllFolders := True;
    Exit;
  end;
  StringChangeEx(Path, '/', '\', True);
  ProtectedLibDir := Lowercase(RemoveBackslashUnlessRoot(ExtractFileDir(Path)));
end;

// True when Dir holds a library database itself: a folder like that is a library folder whatever library.json says.
function HoldsLibraryDatabase(const Dir: string): Boolean;
var
  FR: TFindRec;
begin
  Result := False;
  if FindFirst(Dir + '\*', FR) then
  begin
    try
      repeat
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
          if (Pos('.sqlite', Lowercase(FR.Name)) > 0) or (Lowercase(ExtractFileExt(FR.Name)) = '.db') then begin Result := True; Break; end;
      until not FindNext(FR);
    finally
      FindClose(FR);
    end;
  end;
end;

// A folder DeleteSettingsTree must skip completely (it, its storage\ tree and everything below).
function IsProtectedFolder(const Dir: string): Boolean;
var
  L: string;
begin
  L := Lowercase(Dir);
  Result := False;
  if ProtectAllFolders then Result := ExtractFileName(L) <> 'logs'
  else if (ProtectedLibDir <> '') and ((L = ProtectedLibDir) or (Pos(ProtectedLibDir + '\', L) = 1)) then Result := True
  else if HoldsLibraryDatabase(Dir) then Result := True;
end;

// Deletes every file below Dir except library databases (*.sqlite, *.sqlite-wal, *.sqlite-shm, *.db), then the folders that end up empty.
// Never descends into the configured library's folder or any folder that holds a library database (a library's storage\ attachments live there).
procedure DeleteSettingsTree(const Dir: string);
var
  FR: TFindRec;
  P, L: string;
begin
  if not DirExists(Dir) then Exit;
  if FindFirst(Dir + '\*', FR) then
  begin
    try
      repeat
        if (FR.Name = '.') or (FR.Name = '..') then Continue;
        P := Dir + '\' + FR.Name;
        if (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
        begin
          if ((FR.Attributes and FILE_ATTRIBUTE_REPARSE_POINT) = 0) and (not IsProtectedFolder(P)) then DeleteSettingsTree(P);
        end else
        begin
          L := Lowercase(FR.Name);
          // library.json stays while it points at a library: deleting it would leave that library unfindable after a reinstall
          if (Pos('.sqlite', L) = 0) and (Pos('.db', L) = 0) and not ((L = 'library.json') and (ProtectedLibDir <> '')) then DeleteFile(P);
        end;
      until not FindNext(FR);
    finally
      FindClose(FR);
    end;
  end;
  RemoveDir(Dir); // only succeeds when empty
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Base, Extra: string;
  rc: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    // unregister the browser connector (registry values and manifest); the exe is removed with the rest of the files
    if FileExists(ExpandConstant('{app}\connector\uninstall.ps1')) then
    begin
      rc := RunConnectorScript('uninstall.ps1');
      if rc <> 0 then Log('browser connector unregistration failed (' + IntToStr(rc) + ')');
    end;
    // unregister the Word add-in while its dll is still there
    if FileExists(ExpandConstant('{app}\word\uninstall.ps1')) and (not WordSkipped) then
    begin
      Extra := '';
      // the add-in's own data folders live under the real %APPDATA%/%LOCALAPPDATA%: not with a redirected /ZNAPPDATA test run
      if RemoveSettings and (GetParam('ZNAPPDATA') = '') then Extra := '-RemoveData';
      rc := RunAddinScript('uninstall.ps1', Extra);
      if rc <> 0 then Log('Word add-in unregistration failed (' + IntToStr(rc) + ')');
    end;
  end;
  if (CurUninstallStep = usPostUninstall) and RemoveSettings then
  begin
    Base := GetParam('ZNAPPDATA');
    if Base = '' then Base := ExpandConstant('{userappdata}');
    LoadLibraryProtection(Base + '\zotero-next-gpui');      // a library saved under this folder keeps its whole folder, storage\ included
    DeleteSettingsTree(Base + '\zotero-next-gpui');         // ui-state.json, library.json (the saved library path), logs\
    DelTree(Base + '\zotero-next-gpui.exe', True, True, True); // the web tabs' WebView2 profile
  end;
end;
