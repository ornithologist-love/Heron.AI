const scope = name => `https://www.googleapis.com/auth/${name}`

export const googleServices = [
  { id: 'drive', label: 'Google Drive', scopes: [scope('drive.readonly')], defaultEnabled: true },
  { id: 'docs', label: 'Google Docs', scopes: [scope('documents'), scope('drive.readonly')], defaultEnabled: true },
  { id: 'sheets', label: 'Google Sheets', scopes: [scope('spreadsheets.readonly')] },
  { id: 'slides', label: 'Google Slides', scopes: [scope('presentations.readonly')] },
  { id: 'calendar', label: 'Google Calendar', scopes: [scope('calendar.readonly')] },
  { id: 'gmail', label: 'Gmail', scopes: [scope('gmail.readonly')] },
]
