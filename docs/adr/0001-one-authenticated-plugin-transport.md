# Use one authenticated plugin transport

All Figma Commands use the Bridge Daemon → Figma plugin transport in Safe Mode. We deliberately reject CDP, binary patching and a second execution path because one authenticated transport keeps security, targeting, audit and behaviour in one implementation.
