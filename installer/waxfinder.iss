; Inno Setup: per-user install (no admin), so the app folder stays writable (Waxfinder keeps its data next to its code).
#define AppVer GetEnv("WF_VERSION")
[Setup]
AppId={{8F3C2B1E-5D47-4A9B-9C6E-3A1F00C0FFEE}
AppName=Waxfinder
AppVersion={#AppVer}
DefaultDirName={localappdata}\Programs\Waxfinder
DefaultGroupName=Waxfinder
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=Waxfinder-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Waxfinder.exe
CloseApplications=force
[Files]
Source: "..\dist\Waxfinder\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Waxfinder"; Filename: "{app}\Waxfinder.exe"
Name: "{userdesktop}\Waxfinder"; Filename: "{app}\Waxfinder.exe"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "Desktop shortcut"; Flags: unchecked
[Run]
Filename: "{app}\Waxfinder.exe"; Description: "Start Waxfinder"; Flags: nowait postinstall skipifsilent
