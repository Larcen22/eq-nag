const { spawn } = require( 'child_process' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

/**
 * Linux text-to-speech backend using the Piper neural TTS engine.
 * Synthesizes phrases to WAV files via the piper CLI and plays them
 * through paplay, mirroring the speechSynthesis queue semantics
 * (interrupt / speakNext / queued) used on Windows.
 */

const piperDirEnv = process.env.EQNAG_PIPER_DIR ?? '';
const piperModelEnv = process.env.EQNAG_PIPER_MODEL ?? '';
let piperDirectory = piperDirEnv;
let piperModelFile = piperModelEnv;
const sampleRate = 22050;

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
 * Resolves the piper binary, library directory, and model file for the
 * configured directory. Returns null when Piper is not configured properly.
 */
function resolvePaths() {

    if ( !piperDirectory ) {
        return null;
    }

    const binCandidates = [ path.join( piperDirectory, 'piper' ), path.join( piperDirectory, 'piper', 'piper' ) ];
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

    return { bin, lib: path.dirname( bin ), model };

}

/** @type {{text: string, volume: number, lengthScale: number, sender?: any}[]} */
let queue = [];
/** @type {import('child_process').ChildProcess | null} */
let currentPlayer = null;
let wavCounter = 0;

/**
 * Builds a minimal WAV (mono, 16-bit PCM) around raw Piper output,
 * scaling sample amplitude by the given volume.
 * 
 * @param {Buffer} pcm Raw 16-bit little-endian samples.
 * @param {number} volume Volume factor 0..1.
 */
function buildWav( pcm, volume ) {

    const samples = new Int16Array( pcm.buffer, pcm.byteOffset, Math.floor( pcm.length / 2 ) );
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
 * Synthesizes a phrase with Piper and plays it.
 * 
 * @param {{text: string, volume: number, lengthScale: number, sender?: any}} item The phrase to speak.
 */
function synthesizeAndPlay( item ) {

    const paths = resolvePaths();
    if ( paths == null ) {
        console.error( '[PiperTts] Piper is not configured. Set the Piper folder in Settings > Sound. dir=', JSON.stringify( piperDirectory ) );
        currentPlayer = null;
        if ( item.sender ) {
            item.sender.send( 'tts:piper:done' );
        }
        next();
        return;
    }

    const piper = spawn( paths.bin, [
        '--model', paths.model,
        '--output_raw',
        '--length_scale', String( item.lengthScale ),
        '--quiet',
    ], {
        env: { ...process.env, LD_LIBRARY_PATH: paths.lib },
        stdio: [ 'pipe', 'pipe', 'pipe' ],
    } );

    piper.stderr.on( 'data', chunk => console.error( '[PiperTts] stderr:', chunk.toString().trim() ) );

    piper.stdin.write( item.text + '\n' );
    piper.stdin.end();

    const chunks = [];
    piper.stdout.on( 'data', chunk => chunks.push( chunk ) );

    piper.on( 'error', err => {
        console.error( `[PiperTts] Failed to start piper: ${err.message}` );
        currentPlayer = null;
        next();
    } );

    piper.on( 'close', () => {


        if ( chunks.length === 0 ) {
            currentPlayer = null;
            next();
            return;
        }

        const wavPath = path.join( os.tmpdir(), `eqnag-tts-${process.pid}-${wavCounter++}.wav` );
        fs.writeFileSync( wavPath, buildWav( Buffer.concat( chunks ), item.volume ) );

        const player = spawn( 'paplay', [ wavPath ], { stdio: [ 'ignore', 'ignore', 'pipe' ] } );
        currentPlayer = player;
        player.stderr.on( 'data', chunk => console.error( '[PiperTts] paplay stderr:', chunk.toString().trim() ) );

        player.on( 'error', err => {
            console.error( `[PiperTts] Failed to start paplay: ${err.message}` );
            fs.unlinkSync( wavPath );
            currentPlayer = null;
            next();
        } );

        player.on( 'close', () => {
            try { fs.unlinkSync( wavPath ); } catch {}
            if ( currentPlayer === player ) {
                currentPlayer = null;
                if ( item.sender ) {
                    item.sender.send( 'tts:piper:done' );
                }
                next();
            }
        } );

    } );

}

function next() {
    if ( currentPlayer == null && queue.length > 0 ) {
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
    };

    if ( interrupt && currentPlayer != null ) {
        currentPlayer.kill();
        currentPlayer = null;
        // Drop the next queued phrase so already-queued speech is not re-spoken.
        queue.splice( 0, 1 );
        queue.unshift( item );
        next();
    } else if ( speakNext && ( currentPlayer != null || queue.length > 0 ) ) {
        if ( queue.length > 1 ) {
            queue = [ item, ...queue.slice( 1 ) ];
        } else if ( currentPlayer != null ) {
            queue.unshift( item );
        } else {
            queue.push( item );
        }
        next();
    } else {
        queue.push( item );
        next();
    }

    // Guard against runaway queues if paplay fails repeatedly.
    if ( queue.length > 30 ) {
        queue = queue.slice( 0, 30 );
    }

}

/**
 * Stops all speech and clears the queue.
 */
function cancel() {
    if ( currentPlayer != null ) {
        currentPlayer.kill();
        currentPlayer = null;
    }
    queue = [];
}

module.exports = { speak, cancel, configure };
