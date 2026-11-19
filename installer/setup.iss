#define ProductName "特效模板库"
#define AppExeName "特效模板库.exe"

[Setup]
AppId=com.zylvia.vfx-template-library
AppName={#ProductName}
AppVersion={#ReleaseVersion}
AppPublisher={#ReleaseAuthor}
AppCopyright={#ReleaseCopyright}
VersionInfoVersion={#ReleaseVersion}
VersionInfoCompany={#ReleaseAuthor}
VersionInfoCopyright={#ReleaseCopyright}
VersionInfoProductName={#ProductName}
VersionInfoDescription={#ProductName} 安装程序
DefaultDirName={localappdata}\Programs\VfxTemplateLibrary
DefaultGroupName={#ProductName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release
OutputBaseFilename=VFX-Template-Library-{#ReleaseVersion}-Setup
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "..\release\win-unpacked\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#ProductName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#ProductName}}"; Flags: postinstall nowait skipifsilent
