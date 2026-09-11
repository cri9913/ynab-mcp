param(
    [ValidateSet('Get', 'Set')]
    [string]$Action = 'Set'
)

$ErrorActionPreference = 'Stop'
# Use only this Windows PowerShell installation's modules, not inherited PowerShell 7 modules.
$env:PSModulePath = "$PSHOME\Modules"
$secure = $null

try {
    if ([string]::IsNullOrWhiteSpace($env:YNAB_SECRET_PATH)) {
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or
            -not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container)) {
            throw 'Missing local application data directory.'
        }
        $secretPath = Join-Path $env:LOCALAPPDATA 'LocalSecrets\ynab api key.xml'
    } else {
        $secretPath = [System.IO.Path]::GetFullPath($env:YNAB_SECRET_PATH)
    }

    if ($Action -eq 'Get') {
        if (-not [Console]::IsOutputRedirected) {
            throw 'Credential output requires a private pipe.'
        }
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $secure = Import-Clixml -LiteralPath $secretPath
        if ($secure -isnot [System.Security.SecureString]) {
            throw 'Invalid credential format.'
        }

        $pointer = [IntPtr]::Zero
        try {
            $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $token = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
            if ([string]::IsNullOrWhiteSpace($token) -or $token -match '[\r\n\u2028\u2029]') {
                throw 'Invalid credential value.'
            }
            # Get is for the loader's private child-process pipe, not an interactive console.
            [Console]::Out.Write($token)
        } finally {
            $token = $null
            if ($pointer -ne [IntPtr]::Zero) {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            }
        }
    } else {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        $form = New-Object System.Windows.Forms.Form
        try {
            $form.Text = 'YNAB Credential'
            $form.ClientSize = New-Object System.Drawing.Size(420, 130)
            $form.StartPosition = 'CenterScreen'
            $form.FormBorderStyle = 'FixedDialog'
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false

            $label = New-Object System.Windows.Forms.Label
            $label.Text = 'Enter your YNAB access token:'
            $label.SetBounds(16, 16, 388, 20)

            $inputBox = New-Object System.Windows.Forms.TextBox
            $inputBox.UseSystemPasswordChar = $true
            $inputBox.SetBounds(16, 42, 388, 24)

            $save = New-Object System.Windows.Forms.Button
            $save.Text = 'Save'
            $save.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $save.SetBounds(238, 86, 80, 28)

            $cancel = New-Object System.Windows.Forms.Button
            $cancel.Text = 'Cancel'
            $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $cancel.SetBounds(324, 86, 80, 28)

            $form.Controls.AddRange([System.Windows.Forms.Control[]]@($label, $inputBox, $save, $cancel))
            $form.AcceptButton = $save
            $form.CancelButton = $cancel
            $form.ActiveControl = $inputBox

            if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
                return
            }
            if ([string]::IsNullOrWhiteSpace($inputBox.Text) -or
                $inputBox.Text -match '[\r\n\u2028\u2029]') {
                throw 'Invalid credential value.'
            }
            $secure = ConvertTo-SecureString -String $inputBox.Text -AsPlainText -Force
            $inputBox.Clear()
        } finally {
            $form.Dispose()
        }

        $directory = [System.IO.Path]::GetDirectoryName($secretPath)
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            $parent = [System.IO.Path]::GetDirectoryName($directory)
            if ([string]::IsNullOrWhiteSpace($parent) -or
                -not (Test-Path -LiteralPath $parent -PathType Container)) {
                throw 'Credential directory parent must exist.'
            }
            New-Item -ItemType Directory -Path $directory | Out-Null
        }
        $secure | Export-Clixml -LiteralPath $secretPath
    }
} catch {
    [Console]::Error.WriteLine('Unable to access YNAB credentials.')
    exit 1
} finally {
    if ($secure -is [System.Security.SecureString]) {
        $secure.Dispose()
    }
}
