' Launches rpc.js with no console window. The daemon writes its own rotated
' log to rpc.log, and exits on its own if another copy is already running.
' Double-click to start, or let install-autostart.ps1 run it at login.
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

sh.Run "node """ & dir & "\rpc.js"" --log", 0, False
