const { spawn } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

/**
 * Text-to-speech backend using the Piper neural TTS engine.
 * Synthesizes phrases to WAV files via the piper CLI and plays them,
 * mirroring the speechSynthesis queue semantics (interrupt / speakNext /
 * queued) used on Windows.
 *
 * Playback is platform-specific: Linux uses the first available of paplay,
 * pw-play, aplay or ffplay; Windows plays the generated WAV with PowerShell's
 * System.Media.SoundPlayer (no new deps).
 * The Piper binary is `piper` on Linux and `piper.exe` on Windows.
 */

const piperDirEnv = process.env.EQNAG_PIPER_DIR ?? '';
const piperModelEnv = process.env.EQNAG_PIPER_MODEL ?? '';
let piperDirectory = piperDirEnv;
let piperModelFile = piperModelEnv;
const sampleRate = 22050;
const isWindows = process.platform === 'win32';
const piperBinaryName = isWindows ? 'piper.exe' : 'piper';

// Linux audio players to try, in preference order. A system may ship none of
// them, or only PipeWire's pw-play, so the first resolvable one is used.
const linuxPlayers = [ 'paplay', 'pw-play', 'aplay', 'ffplay' ];

function resolveAudioPlayer() {
    if ( isWindows ) {
        return 'powershell.exe';
    }
    const separators = process.env.PATH_SEPARATOR ?? ':';
    const folders = ( process.env.PATH ?? '' ).split( separators );
    for ( let name of linuxPlayers ) {
        for ( let folder of folders ) {
            try {
                let candidate = path.join( folder, name );
                let stats = fs.statSync( candidate );
                if ( stats.isFile() && ( stats.mode & 0o111 ) ) {
                    return candidate;
                }
            } catch {}
        }
    }
    return null;
}

function audioPlayerArgs( wavPath ) {
    if ( isWindows ) {
        return [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            `(New-Object System.Media.SoundPlayer "${ wavPath }").PlaySync()`,
        ];
    }
    // ffplay needs explicit playback flags; the aplay/paplay family takes a bare file.
    if ( ( path.basename( audioPlayerPath ?? '' ) ) === 'ffplay' ) {
        return [ '-nodisp', '-autoexit', '-loglevel', 'quiet', wavPath ];
    }
    return [ wavPath ];
}

/**
 * Sets the Piper installation folder and voice model from user preferences.
 * 
 * @param {string} directory The folder containing the piper binary and .onnx models.
 * @param {string} modelFile The .onnx model file name within the folder.
 */
function configure( directory, modelFile ) {
    if ( directory ) {
        piperDirectory = directory;
    }
    if ( modelFile ) {
        piperModelFile = modelFile;
    }
}

/**
 * Returns true when Piper is usable (binary + model resolvable in the
 * configured directory). Lets callers fall back to speechSynthesis when
 * Piper is not set up.
 * 
 * @param {string} directory The Piper folder from user preferences.
 * @param {string} modelFile The selected voice model file name.
 */
function isConfigured( directory, modelFile ) {
    configure( directory, modelFile );
    return resolvePaths() != null;
}

/**
 * Resolves the piper binary, library directory, and model file for the
 * configured directory. Returns null when Piper is not configured properly.
 */
function resolvePaths() {

    if ( !piperDirectory ) {
        return null;
    }

    const binCandidates = [
        path.join( piperDirectory, piperBinaryName ),
        path.join( piperDirectory, 'piper', piperBinaryName ),
    ];
    const bin = binCandidates.find( p => {
        try {
            return fs.statSync( p ).isFile();
        } catch {
            return false;
        }
    } );
    if ( !bin ) {
        return null;
    }

    let model = piperModelFile ? ( path.isAbsolute( piperModelFile ) ? piperModelFile : path.join( piperDirectory, piperModelFile ) ) : '';
    if ( !model || !fs.existsSync( model ) ) {
        try {
            const models = fs.readdirSync( piperDirectory ).filter( f => f.endsWith( '.onnx' ) ).sort();
            if ( models.length === 0 ) {
                return null;
            }
            model = path.join( piperDirectory, models[ 0 ] );
        } catch {
            return null;
        }
    }

    // Piper needs espeak-ng-data beside the binary on Windows; without it the
    // binary runs but emits nothing, which would look configured-but-broken.
    if ( isWindows && !fs.existsSync( path.join( path.dirname( bin ), 'espeak-ng-data' ) ) ) {
        return null;
    }

    return { bin, lib: path.dirname( bin ), model };

}

/** @type {{text: string, volume: number, lengthScale: number, sender?: any, doneSent: boolean}[]} */
let queue = [];
/** @type {{child: import('child_process').ChildProcess, item: any, cancelled: boolean} | null} */
let runningSynthesis = null;
/** @type {{child: import('child_process').ChildProcess, item: any, cancelled: boolean} | null} */
let runningPlayback = null;
let audioPlayerPath = undefined;
let wavCounter = 0;

/**
 * Builds a minimal WAV (mono, 16-bit PCM) around raw Piper output,
 * scaling sample amplitude by the given volume.
 * 
 * @param {Buffer} pcm Raw 16-bit little-endian samples.
 * @param {number} volume Volume factor 0..1.
 */
function buildWav( pcm, volume ) {

    const copy = Buffer.from( pcm );
    const samples = new Int16Array( copy.buffer, 0, Math.floor( copy.length / 2 ) );
    if ( volume < 1 ) {
        for ( let i = 0; i < samples.length; i++ ) {
            samples[ i ] = Math.max( -32768, Math.min( 32767, Math.round( samples[ i ] * volume ) ) );
        }
    }

    const data = Buffer.from( samples.buffer, samples.byteOffset, samples.length * 2 );
    const header = Buffer.alloc( 44 );
    header.write( 'RIFF', 0 );
    header.writeUInt32LE( 36 + data.length, 4 );
    header.write( 'WAVE', 8 );
    header.write( 'fmt ', 12 );
    header.writeUInt32LE( 16, 16 );
    header.writeUInt16LE( 1, 20 );                       // PCM
    header.writeUInt16LE( 1, 22 );                       // mono
    header.writeUInt32LE( sampleRate, 24 );
    header.writeUInt32LE( sampleRate * 2, 28 );          // byte rate
    header.writeUInt16LE( 2, 32 );                       // block align
    header.writeUInt16LE( 16, 34 );                      // bits per sample
    header.write( 'data', 36 );
    header.writeUInt32LE( data.length, 40 );

    return Buffer.concat( [ header, data ] );

}

/**
 * Notifies the requesting window that an utterance finished, was interrupted
 * or failed. Always fires so listeners registered with ipcRenderer.once can't
 * accumulate, and never fires twice for the same utterance.
 * 
 * @param {any} item The utterance being finished.
 * @param {string} reason Why the utterance ended (logged).
 */
function finish( item, reason ) {
    if ( item.doneSent ) {
        return;
    }
    item.doneSent = true;
    if ( item.sender ) {
        try {
            if ( !item.sender.isDestroyed() ) {
                item.sender.send( 'tts:piper:done' );
            }
        } catch ( err ) {
            console.error( `[PiperTts] done channel failed: ${ err.message }` );
        }
    }
}

/**
 * Synthesizes a phrase with Piper and plays it.
 * 
 * @param {{text: string, volume: number, lengthScale: number, sender?: any, doneSent: boolean}} item The phrase to speak.
 */
function synthesizeAndPlay( item ) {

    const paths = resolvePaths();
    if ( paths == null ) {
        console.error( '[PiperTts] Piper is not configured. Set the Piper folder in Settings > Sound. dir=', JSON.stringify( piperDirectory ) );
        finish( item, 'not-configured' );
        next();
        return;
    }

    if ( audioPlayerPath === undefined ) {
        audioPlayerPath = resolveAudioPlayer();
        if ( audioPlayerPath === null ) {
            console.error( '[PiperTts] No usable audio player found (tried paplay, pw-play, aplay, ffplay).' );
        }
    }

    const piper = spawn( paths.bin, [
        '--model', paths.model,
        '--output_raw',
        '--length_scale', String( item.lengthScale ),
        '--quiet',
    ], {
        // Linux Piper ships shared libs next to the binary; Windows needs no LD_LIBRARY_PATH.
        env: isWindows ? process.env : { ...process.env, LD_LIBRARY_PATH: paths.lib },
        stdio: [ 'pipe', 'pipe', 'pipe' ],
    } );

    runningSynthesis = { child: piper, item, cancelled: false };

    // A spawn that never starts reports on stdin; swallow it so an unhandled
    // stream error can't take down the main process.
    piper.stdin.on( 'error', () => {} );

    piper.stderr.on( 'data', chunk => console.error( `[PiperTts] stderr: ${ chunk.toString().trim() }` ) );

    piper.stdin.write( item.text + '\n' );
    piper.stdin.end();

    const chunks = [];
    piper.stdout.on( 'data', chunk => chunks.push( chunk ) );

    piper.on( 'error', err => {
        console.error( `[PiperTts] Failed to start piper: ${ err.message }` );
        if ( runningSynthesis?.item === item ) {
            runningSynthesis = null;
            finish( item, 'spawn-failed' );
            next();
        }
    } );

    piper.on( 'close', () => {

        const cancelled = runningSynthesis?.cancelled ?? false;
        if ( runningSynthesis ) {
            runningSynthesis = null;
        }

        if ( cancelled ) {
            finish( item, 'interrupted' );
            next();
            return;
        }

        if ( chunks.length === 0 || audioPlayerPath === null ) {
            finish( item, 'no-audio' );
            next();
            return;
        }

        const wavPath = path.join( os.tmpdir(), `eqnag-tts-${ process.pid }-${ wavCounter++ }.wav` );

        const writeWav = ( err ) => {
            if ( err ) {
                console.error( `[PiperTts] WAV write failed: ${ err.message }` );
                finish( item, 'write-failed' );
                next();
                return;
            }

            const player = isWindows
                ? spawn( 'powershell.exe', audioPlayerArgs( wavPath ), { stdio: [ 'ignore', 'ignore', 'pipe' ] } )
                : spawn( audioPlayerPath, audioPlayerArgs( wavPath ), { stdio: [ 'ignore', 'ignore', 'pipe' ] } );

            runningPlayback = { child: player, item, cancelled: false };

            player.on( 'error', err => {
                console.error( `[PiperTts] Failed to start player: ${ err.message }` );
                try { fs.unlinkSync( wavPath ); } catch {}
                if ( runningPlayback?.child === player ) {
                    runningPlayback = null;
                }
                finish( item, 'playback-failed' );
                next();
            } );

            player.on( 'close', () => {
                try { fs.unlinkSync( wavPath ); } catch {}
                const wasCancelled = runningPlayback?.cancelled ?? false;
                if ( runningPlayback?.child === player ) {
                    runningPlayback = null;
                }
                finish( item, wasCancelled ? 'interrupted' : 'played' );
                next();
            } );

        };

        try {
            fs.writeFile( wavPath, buildWav( Buffer.concat( chunks ), item.volume ), writeWav );
        } catch ( err ) {
            writeWav( err );
        }

    } );

}

function next() {
    if ( runningSynthesis == null && runningPlayback == null && queue.length > 0 ) {
        synthesizeAndPlay( queue.shift() );
    }
}

/**
 * Queues a phrase for speaking, mirroring speechSynthesis semantics.
 * 
 * @param {string} text The phrase to speak.
 * @param {boolean} interrupt If true, stops current speech and discards the next queued phrase.
 * @param {boolean} speakNext If true, places this phrase next in the queue.
 * @param {number} volume Volume factor 0..1.
 * @param {number} rate Speech rate multiplier; converted to Piper's length_scale.
 * @param {import('electron').WebContents} sender The requesting web contents (receives tts:piper:done).
 */
function speak( text, interrupt, speakNext, volume, rate, sender ) {

    const item = {
        text,
        volume: Math.max( 0, Math.min( 1, volume ?? 1 ) ),
        lengthScale: Math.max( 0.5, Math.min( 2, 1 / ( rate || 1 ) ) ),
        sender,
        doneSent: false,
    };

    if ( interrupt && ( runningSynthesis != null || runningPlayback != null ) ) {
        if ( runningSynthesis != null ) {
            runningSynthesis.cancelled = true;
            runningSynthesis.child.kill();
        }
        if ( runningPlayback != null ) {
            runningPlayback.cancelled = true;
            runningPlayback.child.kill();
        }
        // Drop the next queued phrase so already-queued speech is not re-spoken.
        queue.splice( 0, 1 );
        queue.unshift( item );
        next();
    } else if ( speakNext && ( runningSynthesis != null || runningPlayback != null || queue.length > 0 ) ) {
        if ( queue.length > 1 ) {
            queue = [ item, ...queue.slice( 1 ) ];
        } else if ( runningSynthesis != null || runningPlayback != null ) {
            queue.unshift( item );
        } else {
            queue.push( item );
        }
        next();
    } else {
        queue.push( item );
        next();
    }

    if ( queue.length > 30 ) {
        for ( let dropped of queue.slice( 30 ) ) {
            finish( dropped, 'queue-overflow' );
        }
        queue = queue.slice( 0, 30 );
    }

}

/**
 * Stops all speech and clears the queue.
 */
function cancel() {
    if ( runningSynthesis != null ) {
        runningSynthesis.cancelled = true;
        runningSynthesis.child.kill();
    }
    if ( runningPlayback != null ) {
        runningPlayback.cancelled = true;
        runningPlayback.child.kill();
    }
    for ( let dropped of queue ) {
        finish( dropped, 'cancelled' );
    }
    queue = [];
}

module.exports = { speak, cancel, configure, isConfigured };
