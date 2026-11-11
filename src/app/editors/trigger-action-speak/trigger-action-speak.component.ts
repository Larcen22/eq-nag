import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { SettingsKeys, TriggerAction } from 'src/app/core.model';
import { IpcService } from 'src/app/ipc.service';

@Component( {
    selector: 'app-trigger-action-speak',
    templateUrl: 'trigger-action-speak.component.html',
    styleUrls: ['trigger-action-speak.component.scss']
} )
export class TriggerActionSpeakComponent implements OnInit {

    @Input() public action: TriggerAction;

    private voiceOptions: SpeechSynthesisVoice[] = [];
    private voiceIndex: number = null;
    private piperAvailable: boolean = false;

    constructor(
        private readonly ipcService: IpcService,
    ) {
        speechSynthesis.onvoiceschanged = () => {
            this.voiceOptions = speechSynthesis.getVoices();
        };
        this.voiceOptions = speechSynthesis.getVoices();
    }

    ngOnInit() {
        this.ipcService.getSetting<number>( SettingsKeys.voiceIndex ).subscribe( index => this.voiceIndex = index );
        if ( !navigator.platform.toLowerCase().includes( 'linux' ) ) {
            this.ipcService.getPiperAvailable().subscribe( available => this.piperAvailable = available );
        }
    }

    /**
     * Uses TTS to speak the given phrase.
     * 
     * @param phrase The phrase to speak.
     */
    speakPhrase( phrase: string, rate: number ): void {
        if ( navigator.platform.toLowerCase().includes( 'linux' ) || this.piperAvailable ) {
            window.api.ipc.send( 'tts:piper:speak', { text: phrase.replace( /\$/gi, '' ).replace( /\{/gi, '' ).replace( /\}/gi, '' ), interrupt: true, speakNext: false, volume: 1, rate: rate ?? 1 } );
            return;
        }
        var utter = new SpeechSynthesisUtterance();
        utter.text = phrase.replace( /\$/gi, '' ).replace( /\{/gi, '' ).replace( /\}/gi, '' );
        utter.voice = this.voiceOptions[ this.voiceIndex ];
        utter.onend = function ( event ) { }
        utter.rate = rate ?? 1;
        speechSynthesis.speak( utter );
    }

}
