Option Explicit

Dim shell, projectDir, command
Set shell = CreateObject("WScript.Shell")

projectDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /c cd /d """ & projectDir & """ && node server.js"

' 0 = hidden window, False = do not wait for the server process.
shell.Run command, 0, False

Set shell = Nothing
