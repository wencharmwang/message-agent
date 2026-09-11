// tsx asks os.userInfo() only to name its temporary directory. Some Windows
// sessions return ENOMEM for that API even though USERNAME and the temp path
// are available. Supplying the same stable identifier keeps startup reliable.
if (process.platform === 'win32' && typeof process.geteuid !== 'function') {
  process.geteuid = () => process.env.USERNAME || 'message-agent';
}
