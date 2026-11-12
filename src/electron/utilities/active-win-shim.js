const { spawn } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

/**
 * Cross-platform replacement for the `active-win` npm package.
 *
 * active-win ships prebuilt native addons for win32 and darwin only; loading
 * it on Linux throws at import time. This module keeps that dependency off the
 * Linux code path and falls back to a Win32 P/Invoke lookup on Windows, which
 * needs no native build.
 *
 * Returns the same shape active-win yields, or undefined:
 *   { id, title, platform, owner: { name, processId, path } }
 */

let powershellScriptPath = null;

function ensurePowerShellScript() {
    if ( powershellScriptPath !== null ) {
        return powershellScriptPath;
    }
    const ps = [
        'Add-Type -Namespace EqNag -Name WindowQuery -MemberCode @"',
        'using System.Text;',
        'public class WindowQuery {',
        '  [DllImport("user32.dll")] public static IntPtr GetForegroundWindow();',
        '  [DllImport("user32.dll")] public static uint GetWindowThreadProcessId(IntPtr h, out uint p);',
        '  [DllImport("user32.dll")] public static int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
        '  public static string[] Query() {',
        '    IntPtr h = GetForegroundWindow();',
        '    uint p = 0; GetWindowThreadProcessId(h, out p);',
        '    var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity);',
        '    return new[] { h.ToInt64().ToString(), p.ToString(), sb.ToString() };',
        '  }',
        '}"@',
        '$q = [EqNag::WindowQuery]::Query();',
        '$name = ""; try { $name = (Get-Process -Id ([uint32]$q[1]) -ErrorAction Stop).ProcessName } catch {}',
        '$title = ($q[2] -replace "[`r`n`t]", " ");',
        'Write-Output "$($q[0])`t$($q[1])`t$($name)`t$($title)"',
    ].join( '\n' );

    const target = path.join( os.tmpdir(), `eqnag-active-window-${ process.pid }.ps1` );
    try {
        fs.writeFileSync( target, ps );
        powershellScriptPath = target;
    } catch {
        powershellScriptPath = null;
    }
    return powershellScriptPath;
}

function getActiveWindowNative() {
    return new Promise( ( resolve ) => {
        try {
            const activeWin = require( 'active-win' );
            activeWin().then( ( result ) => resolve( result ) )
                .catch( () => resolve( null ) );
        } catch {
            resolve( null );
        }
    } );
}

function getActiveWindowPowerShell() {
    return new Promise( ( resolve ) => {
        const script = ensurePowerShellScript();
        if ( script === null ) {
            resolve( undefined );
            return;
        }
        const child = spawn( 'powershell.exe',
            [ '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script ],
            { windowsHide: true, stdio: [ 'ignore', 'pipe', 'ignore' ] } );
        let out = '';
        child.stdout.on( 'data', ( chunk ) => out += chunk.toString() );
        child.on( 'error', () => resolve( undefined ) );
        child.on( 'close', () => {
            const columns = out.trim().split( '\t' );
            if ( columns.length < 4 ) {
                resolve( undefined );
                return;
            }
            resolve( {
                id: Number( columns[ 0 ] ),
                owner: {
                    processId: Number( columns[ 1 ] ),
                    name: columns[ 2 ],
                    path: '',
                },
                title: columns.slice( 3 ).join( '\t' ),
                platform: 'win32',
            } );
        } );
    } );
}

module.exports = async () => {
    if ( process.platform === 'win32' || process.platform === 'darwin' ) {
        const native = await getActiveWindowNative();
        if ( native ) {
            return native;
        }
        if ( process.platform === 'win32' ) {
            return await getActiveWindowPowerShell();
        }
    }
    return undefined;
};

module.exports.default = module.exports;
