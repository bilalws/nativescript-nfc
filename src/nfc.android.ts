import {
  AndroidActivityEventData,
  AndroidActivityNewIntentEventData,
  AndroidApplication,
  Application,
  Utils
} from "@nativescript/core";
import {
  NdefListenerOptions,
  NfcApi,
  NfcNdefData,
  NfcNdefRecord,
  NfcTagData,
  NfcUriProtocols,
  WriteTagOptions
} from "./nfc.common";

declare let Array: any;

const sdk31Intent = {
  FLAG_MUTABLE: 33554432,
  FLAG_IMMUTABLE: 67108864
};

const ApduData = {
  CardSelect: {
    SELECT_NONE: 0,
    SELECT_CCFILE: 1,
    SELECT_NDEFFILE: 2
  },

  APDU_INS: 1,
  APDU_P1: 2,
  APDU_P2: 3,
  APDU_SELECT_LC: 4,
  APDU_READ_LE: 4,

  FILEID_CC: 0xe103,
  FILEID_NDEF: 0xe104,

  INS_SELECT: new java.lang.Byte(0xa4),
  INS_READ: new java.lang.Byte(0xb0),

  P1_SELECT_BY_NAME: new java.lang.Byte(0x04),
  P1_SELECT_BY_ID: new java.lang.Byte(0x00),

  DATA_OFFSET: 5,
  DATA_SELECT_NDEF: java.nio.ByteBuffer.wrap([
    0xd2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01
  ]).array(),
  RET_COMPLETE: java.nio.ByteBuffer.wrap([0x90, 0x00]).array(),
  RET_NONDEF: java.nio.ByteBuffer.wrap([0x6a, 0x82]).array(),

  FILE_CC: java.nio.ByteBuffer.wrap([
    0x00,
    0x0f, //LEN
    0x20, //Mapping Version
    0x00,
    0x40, //MLe
    0x00,
    0x40, //MLc

    //TLV(NDEF File Control)
    0x04, //Tag
    0x06, //LEN
    0xe1,
    0x04, //signature
    0x00,
    0x32, //max ndef size
    0x00, //read access permission
    0x00 //write access permission
  ]).array()
};

const CardData = {
  mCardSelect: ApduData.CardSelect.SELECT_NONE,
  mNdefFile: null,
  mSelectNdef: false
};

let onTagDiscoveredListener: (data: NfcTagData) => void = null;
let onNdefDiscoveredListener: (data: NfcNdefData) => void = null;

export class NfcIntentHandler {
  public savedIntent: android.content.Intent = null;

  constructor() {}

  parseMessage(): void {
    const activity =
      Application.android.foregroundActivity ||
      Application.android.startActivity;
    let intent = activity.getIntent();
    if (intent === null || this.savedIntent === null) {
      return;
    }

    let action = intent.getAction();
    if (action === null) {
      return;
    }

    let tag = intent.getParcelableExtra(
      android.nfc.NfcAdapter.EXTRA_TAG
    ) as android.nfc.Tag;
    if (!tag) {
      return;
    }

    let messages = intent.getParcelableArrayExtra(
      android.nfc.NfcAdapter.EXTRA_NDEF_MESSAGES
    );

    // every action should map to a different listener you pass in at 'startListening'
    if (action === android.nfc.NfcAdapter.ACTION_NDEF_DISCOVERED) {
      let ndef = android.nfc.tech.Ndef.get(tag);

      let ndefJson: NfcNdefData = this.ndefToJSON(ndef);

      if (ndef === null && messages !== null) {
        if (messages.length > 0) {
          let message = messages[0] as android.nfc.NdefMessage;
          ndefJson.message = this.messageToJSON(message);
          ndefJson.type = "NDEF Push Protocol";
        }
        if (messages.length > 1) {
          console.log("Expected 1 ndefMessage but found " + messages.length);
        }
      }

      if (onNdefDiscoveredListener === null) {
        console.log(
          "Ndef discovered, but no listener was set via setOnNdefDiscoveredListener. Ndef: " +
            JSON.stringify(ndefJson)
        );
      } else {
        onNdefDiscoveredListener(ndefJson);
      }
      activity.getIntent().setAction("");
    } else if (action === android.nfc.NfcAdapter.ACTION_TECH_DISCOVERED) {
      let techList = tag.getTechList();

      for (let i = 0; i < tag.getTechList().length; i++) {
        let tech = tag.getTechList()[i];
        /*
        let tagTech = techList(t);
        console.log("tagTech: " + tagTech);
        if (tagTech === NdefFormatable.class.getName()) {
          fireNdefFormatableEvent(tag);
        } else if (tagTech === Ndef.class.getName()) {
          let ndef = Ndef.get(tag);
          fireNdefEvent(NDEF, ndef, messages);
        }
        */
      }
      activity.getIntent().setAction("");
    } else if (action === android.nfc.NfcAdapter.ACTION_TAG_DISCOVERED) {
      let result: NfcTagData = {
        id: tag === null ? null : this.byteArrayToJSArray(tag.getId()),
        techList: this.techListToJSON(tag)
      };

      if (onTagDiscoveredListener === null) {
        console.log(
          "Tag discovered, but no listener was set via setOnTagDiscoveredListener. Ndef: " +
            JSON.stringify(result)
        );
      } else {
        onTagDiscoveredListener(result);
      }
      activity.getIntent().setAction("");
    }
  }

  byteArrayToJSArray(bytes): Array<number> {
    let result = [];
    for (let i = 0; i < bytes.length; i++) {
      result.push(bytes[i]);
    }
    return result;
  }

  byteArrayToJSON(bytes): string {
    let json = new org.json.JSONArray();
    for (let i = 0; i < bytes.length; i++) {
      json.put(bytes[i]);
    }
    return json.toString();
  }

  bytesToHexString(bytes): string {
    let dec,
      hexstring,
      bytesAsHexString = "";
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] >= 0) {
        dec = bytes[i];
      } else {
        dec = 256 + bytes[i];
      }
      hexstring = dec.toString(16);
      // zero padding
      if (hexstring.length === 1) {
        hexstring = "0" + hexstring;
      }
      bytesAsHexString += hexstring;
    }
    return bytesAsHexString;
  }

  bytesToString(bytes): string {
    let result = "";
    let i, c, c1, c2, c3;
    i = c = c1 = c2 = c3 = 0;

    // Perform byte-order check
    if (bytes.length >= 3) {
      if (
        (bytes[0] & 0xef) === 0xef &&
        (bytes[1] & 0xbb) === 0xbb &&
        (bytes[2] & 0xbf) === 0xbf
      ) {
        // stream has a BOM at the start, skip over
        i = 3;
      }
    }

    while (i < bytes.length) {
      c = bytes[i] & 0xff;

      if (c < 128) {
        result += String.fromCharCode(c);
        i++;
      } else if (c > 191 && c < 224) {
        if (i + 1 >= bytes.length) {
          throw "Un-expected encoding error, UTF-8 stream truncated, or incorrect";
        }
        c2 = bytes[i + 1] & 0xff;
        result += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
        i += 2;
      } else {
        if (i + 2 >= bytes.length || i + 1 >= bytes.length) {
          throw "Un-expected encoding error, UTF-8 stream truncated, or incorrect";
        }
        c2 = bytes[i + 1] & 0xff;
        c3 = bytes[i + 2] & 0xff;
        result += String.fromCharCode(
          ((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63)
        );
        i += 3;
      }
    }
    return result;
  }

  techListToJSON(tag): Array<string> {
    if (tag !== null) {
      let techList = [];
      for (let i = 0; i < tag.getTechList().length; i++) {
        techList.push(tag.getTechList()[i]);
      }
      return techList;
    }
    return null;
  }

  ndefToJSON(ndef: android.nfc.tech.Ndef): NfcNdefData {
    if (ndef === null) {
      return null;
    }

    let result = {
      type: ndef.getType()[0],
      maxSize: ndef.getMaxSize(),
      writable: ndef.isWritable(),
      message: this.messageToJSON(ndef.getCachedNdefMessage()),
      canMakeReadOnly: ndef.canMakeReadOnly()
    } as NfcNdefData;

    let tag = ndef.getTag();
    if (tag !== null) {
      result.id = this.byteArrayToJSArray(tag.getId());
      result.techList = this.techListToJSON(tag);
    }

    return result;
  }

  messageToJSON(message: android.nfc.NdefMessage): Array<NfcNdefRecord> {
    try {
      if (message === null) {
        return null;
      }
      let records = message.getRecords();
      let result = [];
      for (let i = 0; i < records.length; i++) {
        let record = this.recordToJSON(records[i]);
        result.push(record);
      }
      return result;
    } catch (e) {
      console.log("Error in messageToJSON: " + e);
      return null;
    }
  }

  recordToJSON(record: android.nfc.NdefRecord): NfcNdefRecord {
    let payloadAsString = this.bytesToString(record.getPayload());
    const payloadAsStringWithPrefix = payloadAsString;
    const type = record.getType()[0];

    if (type === android.nfc.NdefRecord.RTD_TEXT[0]) {
      let languageCodeLength = record.getPayload()[0];
      payloadAsString = payloadAsStringWithPrefix.substring(
        languageCodeLength + 1
      );
    } else if (type === android.nfc.NdefRecord.RTD_URI[0]) {
      let prefix = NfcUriProtocols[record.getPayload()[0]];
      if (!prefix) {
        prefix = "";
      }
      payloadAsString = prefix + payloadAsString.slice(1);
    }

    return {
      tnf: record.getTnf(),
      type: type,
      id: this.byteArrayToJSArray(record.getId()),
      payload: this.byteArrayToJSON(record.getPayload()),
      payloadAsHexString: this.bytesToHexString(record.getPayload()),
      payloadAsStringWithPrefix: payloadAsStringWithPrefix,
      payloadAsString: payloadAsString
    };
  }
}

@NativeClass()
@JavaProxy("com.tns.NdefHostApduService")
class NdefHostApduService extends android.nfc.cardemulation.HostApduService {
  onStartCommand(
    intent: android.content.Intent,
    flags: number,
    startId: number
  ) {
    let message = intent.getParcelableExtra("EXTRA_NDEF_MESSAGES");

    console.log("onStartCommand ndefMessage: ", message);

    let ndefMessage = message as android.nfc.NdefMessage;
    let ndefarray = ndefMessage.toByteArray();

    CardData.mNdefFile = Array.create("byte", 2 + ndefarray.length);

    CardData.mNdefFile[0] = new java.lang.Byte(
      (ndefarray.length & 0xff00) >> 8
    );
    CardData.mNdefFile[1] = new java.lang.Byte(ndefarray.length & 0x00ff);

    java.lang.System.arraycopy(
      ndefarray,
      0,
      CardData.mNdefFile,
      2,
      ndefarray.length
    );

    return android.app.Service.START_STICKY;
  }

  onDeactivated(reason: number) {
    CardData.mCardSelect = ApduData.CardSelect.SELECT_NONE;
    CardData.mSelectNdef = false;
    console.log("Deactivated.", reason);
  }

  processCommandApdu(
    commandApdu: native.Array<number>,
    extras?: android.os.Bundle
  ): native.Array<number> {
    let ret = false;
    let retData: native.Array<number> = null;

    switch (commandApdu[ApduData.APDU_INS]) {
      case ApduData.INS_SELECT.intValue():
        switch (commandApdu[ApduData.APDU_P1]) {
          case ApduData.P1_SELECT_BY_NAME.intValue():
            // 1. NDEF Tag Application Select
            if (
              this.memCmp(
                commandApdu,
                ApduData.DATA_OFFSET,
                ApduData.DATA_SELECT_NDEF,
                0,
                commandApdu[ApduData.APDU_SELECT_LC]
              )
            ) {
              //select NDEF application
              CardData.mSelectNdef = true;
              ret = true;
            } else {
              console.log("select: fail");
            }
            break;

          case ApduData.P1_SELECT_BY_ID.intValue():
            if (CardData.mSelectNdef) {
              let file_id = 0;
              for (
                let loop = 0;
                loop < commandApdu[ApduData.APDU_SELECT_LC];
                loop++
              ) {
                file_id <<= 8;
                file_id |= commandApdu[ApduData.DATA_OFFSET + loop] & 0xff;
              }

              switch (file_id) {
                case ApduData.FILEID_CC:
                  CardData.mCardSelect = ApduData.CardSelect.SELECT_CCFILE;
                  ret = true;
                  break;

                case ApduData.FILEID_NDEF:
                  CardData.mCardSelect = ApduData.CardSelect.SELECT_NDEFFILE;
                  ret = true;
                  break;

                default:
                  break;
              }
            } else {
              console.log("select: not select NDEF app");
            }

            break;

          default:
            console.log(
              "select: unknown p1 : " + commandApdu[ApduData.APDU_P1]
            );
            break;
        }
        break;

      case ApduData.INS_READ.intValue():
        if (CardData.mSelectNdef) {
          let offset =
            (commandApdu[ApduData.APDU_P1] << 8) |
            commandApdu[ApduData.APDU_P2];
          let src: native.Array<number> = null;
          switch (CardData.mCardSelect) {
            case ApduData.CardSelect.SELECT_CCFILE:
              src = ApduData.FILE_CC;
              ret = true;
              break;

            case ApduData.CardSelect.SELECT_NDEFFILE:
              console.log("SELECT_NDEFFILE");
              src = CardData.mNdefFile;
              ret = true;
              break;

            default:
              console.log("read: fail : no select");
              break;
          }

          if (ret && src) {
            retData = Array.create(
              "byte",
              commandApdu[ApduData.APDU_READ_LE] + ApduData.RET_COMPLETE.length
            );

            java.lang.System.arraycopy(
              src,
              offset,
              retData,
              0,
              commandApdu[ApduData.APDU_READ_LE]
            );
            //complete
            java.lang.System.arraycopy(
              ApduData.RET_COMPLETE,
              0,
              retData,
              commandApdu[ApduData.APDU_READ_LE],
              ApduData.RET_COMPLETE.length
            );
          }

          break;
        } else {
          console.log("read: not select NDEF app");
        }

        break;

      default:
        console.log("unknown INS : " + commandApdu[ApduData.APDU_INS]);
        break;
    }

    if (ret) {
      if (retData == null) {
        console.log("return complete");
        retData = ApduData.RET_COMPLETE;
      } else {
        console.log("------------------------------");
        console.log(retData);
        console.log("------------------------------");
      }
    } else {
      console.log("return no ndef");
      retData = ApduData.RET_NONDEF;
    }
    return retData;
  }

  private memCmp(
    p1: native.Array<number>,
    offset1: number,
    p2: native.Array<number>,
    offset2: number,
    cmpLen: number
  ) {
    let len = p1.length;
    if (len < offset1 + cmpLen || p2.length < offset2 + cmpLen) {
      return false;
    }

    let ret = true;
    for (let loop = 0; loop < cmpLen; loop++) {
      if (p1[offset1 + loop] != p2[offset2 + loop]) {
        ret = false;
        break;
      }
    }

    return ret;
  }
}

export const nfcIntentHandler = new NfcIntentHandler();

export class Nfc implements NfcApi {
  private pendingIntent: android.app.PendingIntent;
  private intentFilters: any;
  private techLists: any;
  private static firstInstance = true;
  private created = false;
  private started = false;
  private isNdefHCEMode = false;
  private isReadonly = false;
  private intent: android.content.Intent;
  private hceIntent: android.content.Intent;
  private nfcAdapter: android.nfc.NfcAdapter;

  constructor(isNdefHCEMode: boolean = false, isReadonly: boolean = false) {
    this.isNdefHCEMode = isNdefHCEMode;
    this.intentFilters = [];
    this.techLists = Array.create("[Ljava.lang.String;", 0);

    this.initNfcAdapter();

    // note: once peer2peer is supported, handle possible pending push messages here

    // only wire these events once
    if (Nfc.firstInstance) {
      Nfc.firstInstance = false;

      // The Nfc adapter may not yet be ready, in case the class was instantiated in a very early stage of the app.
      Application.android.on(
        AndroidApplication.activityCreatedEvent,
        (args: AndroidActivityEventData) => {
          this.initNfcAdapter();
        }
      );

      Application.android.on(
        AndroidApplication.activityPausedEvent,
        (args: AndroidActivityEventData) => {
          let pausingNfcAdapter = android.nfc.NfcAdapter.getDefaultAdapter(
            args.activity
          );
          if (pausingNfcAdapter !== null) {
            try {
              this.nfcAdapter.disableForegroundDispatch(args.activity);
              if (this.isNdefHCEMode) {
                let cardEmulation =
                  android.nfc.cardemulation.CardEmulation.getInstance(
                    this.nfcAdapter
                  );
                (cardEmulation as any).unsetPreferredService(args.activity);
              }
            } catch (e) {
              console.log(
                "Illegal State Exception stopping NFC. Assuming application is terminating."
              );
            }
          }
        }
      );

      Application.android.on(
        AndroidApplication.activityResumedEvent,
        (args: AndroidActivityEventData) => {
          let resumingNfcAdapter = android.nfc.NfcAdapter.getDefaultAdapter(
            args.activity
          );
          if (resumingNfcAdapter !== null && !args.activity.isFinishing()) {
            this.started = true;
            if (this.isNdefHCEMode) {
              let cardEmulation =
                android.nfc.cardemulation.CardEmulation.getInstance(
                  this.nfcAdapter
                );
              let hceComponentName = new android.content.ComponentName(
                Utils.android.getApplicationContext(),
                NdefHostApduService.class
              );
              console.log(
                "setPreferredService",
                (cardEmulation as any).setPreferredService(
                  args.activity,
                  hceComponentName
                )
              );
            }

            resumingNfcAdapter.enableForegroundDispatch(
              args.activity,
              this.pendingIntent,
              this.intentFilters,
              this.techLists
            );
            // handle any pending intent
            nfcIntentHandler.parseMessage();
          }
        }
      );

      // fired when a new tag is scanned
      Application.android.on(
        AndroidApplication.activityNewIntentEvent,
        (args: AndroidActivityNewIntentEventData) => {
          nfcIntentHandler.savedIntent = this.intent;
          nfcIntentHandler.parseMessage();
        }
      );

      Application.android.on(
        AndroidApplication.activityDestroyedEvent,
        (args: AndroidActivityEventData) => {}
      );
    }
  }

  public available(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let nfcAdapter = android.nfc.NfcAdapter.getDefaultAdapter(
        Utils.android.getApplicationContext()
      );
      resolve(nfcAdapter !== null);
    });
  }

  public enabled(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      let nfcAdapter = android.nfc.NfcAdapter.getDefaultAdapter(
        Utils.android.getApplicationContext()
      );
      resolve(nfcAdapter !== null && nfcAdapter.isEnabled());
    });
  }

  public setOnTagDiscoveredListener(
    callback: (data: NfcTagData) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      onTagDiscoveredListener = callback;
      resolve();
    });
  }

  public setOnNdefDiscoveredListener(
    callback: (data: NfcNdefData) => void,
    options?: NdefListenerOptions
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // TODO use options, some day
      onNdefDiscoveredListener = callback;
      resolve();
    });
  }

  public setNdefHCEMode(arg: WriteTagOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      let records = this.jsonToNdefRecords(arg);
      let ndefClass = android.nfc.NdefMessage as any;
      let ndefMessage = new ndefClass(records);
      let ndefarray = ndefMessage.toByteArray();

      CardData.mNdefFile = Array.create("byte", 2 + ndefarray.length);

      CardData.mNdefFile[0] = new java.lang.Byte(
        (ndefarray.length & 0xff00) >> 8
      );
      CardData.mNdefFile[1] = new java.lang.Byte(ndefarray.length & 0x00ff);

      java.lang.System.arraycopy(
        ndefarray,
        0,
        CardData.mNdefFile,
        2,
        ndefarray.length
      );

      // const activity =
      //   Application.android.foregroundActivity ||
      //   Application.android.startActivity;
      // if (activity) {
      //   if (this.created) {
      //     let records = this.jsonToNdefRecords(arg);
      //     let ndefClass = android.nfc.NdefMessage as any;
      //     let ndefMessage = new ndefClass(records);
      //     let context = Utils.android.getApplicationContext();

      //     console.log(
      //       "HCE available",
      //       Application.android.context
      //         .getPackageManager()
      //         .hasSystemFeature(
      //           android.content.pm.PackageManager
      //             .FEATURE_NFC_HOST_CARD_EMULATION
      //         )
      //     );
      //     this.hceIntent = new android.content.Intent(
      //       context,
      //       NdefHostApduService.class
      //     );
      //     this.hceIntent.putExtra("EXTRA_NDEF_MESSAGES", ndefMessage);

      //     console.log("startService");
      //     context.startService(this.hceIntent);
      //   }
      // }
      resolve();
    });
  }

  public eraseTag(): Promise<void> {
    return new Promise((resolve, reject) => {
      const intent =
        Application.android.foregroundActivity.getIntent() ||
        nfcIntentHandler.savedIntent;
      if (!intent) {
        reject("Can't erase tag; didn't receive an intent");
        return;
      }

      let tag = intent.getParcelableExtra(
        android.nfc.NfcAdapter.EXTRA_TAG
      ) as android.nfc.Tag;
      let records = new Array.create(android.nfc.NdefRecord, 1);

      let tnf = android.nfc.NdefRecord.TNF_EMPTY;
      let type = Array.create("byte", 0);
      let id = Array.create("byte", 0);
      let payload = Array.create("byte", 0);
      records[0] = new android.nfc.NdefRecord(tnf, type, id, payload);

      // avoiding a TS issue in the generate Android definitions
      let ndefClass = android.nfc.NdefMessage as any;
      let ndefMessage = new ndefClass(records);

      let errorMessage = Nfc.writeNdefMessage(ndefMessage, tag);
      if (errorMessage === null) {
        resolve();
      } else {
        reject(errorMessage);
      }
    });
  }

  public writeTag(arg: WriteTagOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!arg) {
          reject("Nothing passed to write");
          return;
        }

        const intent =
          Application.android.foregroundActivity.getIntent() ||
          nfcIntentHandler.savedIntent;
        if (!intent) {
          reject("Can't write to tag; didn't receive an intent");
          return;
        }

        let tag = intent.getParcelableExtra(
          android.nfc.NfcAdapter.EXTRA_TAG
        ) as android.nfc.Tag;
        if (!tag) {
          reject("No tag found to write to");
          return;
        }

        let records = this.jsonToNdefRecords(arg);

        // avoiding a TS issue in the generate Android definitions
        let ndefClass = android.nfc.NdefMessage as any;
        let ndefMessage = new ndefClass(records);

        let errorMessage = Nfc.writeNdefMessage(ndefMessage, tag);
        if (errorMessage === null) {
          resolve();
        } else {
          reject(errorMessage);
        }
      } catch (ex) {
        reject(ex);
      }
    });
  }

  private initNfcAdapter() {
    if (!this.created) {
      const activity =
        Application.android.foregroundActivity ||
        Application.android.startActivity;
      if (activity) {
        this.created = true;
        this.intent = new android.content.Intent(activity, activity.getClass());
        this.intent.addFlags(
          android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP |
            android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP
        );
        this.pendingIntent = android.app.PendingIntent.getActivity(
          activity,
          0,
          this.intent,
          android.os.Build.VERSION.SDK_INT < 31 ? 0 : sdk31Intent.FLAG_MUTABLE
        );

        // The adapter must be started with the foreground activity.
        // This allows to start it as soon as possible but only once.
        const foregroundActivity = Application.android.foregroundActivity;
        this.nfcAdapter = android.nfc.NfcAdapter.getDefaultAdapter(
          Utils.android.getApplicationContext()
        );

        if (this.isNdefHCEMode) {
          let cardEmulation =
            android.nfc.cardemulation.CardEmulation.getInstance(
              this.nfcAdapter
            );
          console.log(
            "categoryAllowsForegroundPreference",
            (cardEmulation as any).categoryAllowsForegroundPreference("other")
          );
        }

        if (!this.started && this.nfcAdapter !== null && foregroundActivity) {
          this.started = true;
          this.nfcAdapter.enableForegroundDispatch(
            foregroundActivity,
            this.pendingIntent,
            this.intentFilters,
            this.techLists
          );
          // handle any pending intent
          nfcIntentHandler.parseMessage();
        }
      }
    }
  }

  private static writeNdefMessage(
    message: android.nfc.NdefMessage,
    tag: android.nfc.Tag
  ): string {
    let ndef = android.nfc.tech.Ndef.get(tag);

    if (ndef === null) {
      let formatable = android.nfc.tech.NdefFormatable.get(tag);
      if (formatable === null) {
        return "Tag doesn't support NDEF";
      }
      formatable.connect();
      formatable.format(message);
      formatable.close();
      return null;
    }

    try {
      ndef.connect();
    } catch (e) {
      console.log("ndef connection error: " + e);
      return "connection failed";
    }

    if (!ndef.isWritable()) {
      return "Tag not writable";
    }

    let size = message.toByteArray().length;
    let maxSize = ndef.getMaxSize();

    if (maxSize < size) {
      return (
        "Message too long; tag capacity is " +
        maxSize +
        " bytes, message is " +
        size +
        " bytes"
      );
    }

    ndef.writeNdefMessage(message);
    ndef.close();
    return null;
  }

  private jsonToNdefRecords(
    input: WriteTagOptions
  ): Array<android.nfc.NdefRecord> {
    let nrOfRecords = 0;
    nrOfRecords += input.textRecords ? input.textRecords.length : 0;
    nrOfRecords += input.uriRecords ? input.uriRecords.length : 0;
    let records = new Array.create(android.nfc.NdefRecord, nrOfRecords);

    let recordCounter: number = 0;

    if (input.textRecords !== null) {
      for (let i in input.textRecords) {
        let textRecord = input.textRecords[i];

        let langCode = textRecord.languageCode || "en";
        let encoded = Nfc.stringToBytes(langCode + textRecord.text);
        encoded.unshift(langCode.length);

        let tnf = android.nfc.NdefRecord.TNF_WELL_KNOWN; // 0x01;

        let type = Array.create("byte", 1);
        type[0] = 0x54;

        let id = Array.create("byte", textRecord.id ? textRecord.id.length : 0);
        if (textRecord.id) {
          for (let j = 0; j < textRecord.id.length; j++) {
            id[j] = textRecord.id[j];
          }
        }

        let payload = Array.create("byte", encoded.length);
        for (let n = 0; n < encoded.length; n++) {
          payload[n] = encoded[n];
        }

        records[recordCounter++] = new android.nfc.NdefRecord(
          tnf,
          type,
          id,
          payload
        );
      }
    }

    if (input.uriRecords !== null) {
      for (let i in input.uriRecords) {
        let uriRecord = input.uriRecords[i];
        let uri = uriRecord.uri;

        let prefix;

        NfcUriProtocols.slice(1).forEach(protocol => {
          if ((!prefix || prefix === "urn:") && uri.indexOf(protocol) === 0) {
            prefix = protocol;
          }
        });

        if (!prefix) {
          prefix = "";
        }

        let encoded = Nfc.stringToBytes(uri.slice(prefix.length));
        // prepend protocol code
        encoded.unshift(NfcUriProtocols.indexOf(prefix));

        let tnf = android.nfc.NdefRecord.TNF_WELL_KNOWN; // 0x01;

        let type = Array.create("byte", 1);
        type[0] = 0x55;

        let id = Array.create("byte", uriRecord.id ? uriRecord.id.length : 0);
        if (uriRecord.id) {
          for (let j = 0; j < uriRecord.id.length; j++) {
            id[j] = uriRecord.id[j];
          }
        }

        let payload = Array.create("byte", encoded.length);
        for (let n = 0; n < encoded.length; n++) {
          payload[n] = encoded[n];
        }

        records[recordCounter++] = new android.nfc.NdefRecord(
          tnf,
          type,
          id,
          payload
        );
      }
    }
    return records;
  }

  private static stringToBytes(input: string) {
    let bytes = [];
    for (let n = 0; n < input.length; n++) {
      let c = input.charCodeAt(n);
      if (c < 128) {
        bytes[bytes.length] = c;
      } else if (c > 127 && c < 2048) {
        bytes[bytes.length] = (c >> 6) | 192;
        bytes[bytes.length] = (c & 63) | 128;
      } else {
        bytes[bytes.length] = (c >> 12) | 224;
        bytes[bytes.length] = ((c >> 6) & 63) | 128;
        bytes[bytes.length] = (c & 63) | 128;
      }
    }
    return bytes;
  }
}
