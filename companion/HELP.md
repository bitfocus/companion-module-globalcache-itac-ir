## Global Caché iTach IR

Control projectors, displays and other IR devices through a Global Caché iTach IP2IR or WF2IR. Other Global Caché units that speak the same TCP API (GC-100, Flex) should also work by setting the IR module address.

### Setup

1. Enter the **IP address** of the iTach. Find it with the iHelp utility or in your router's DHCP client list. Give the iTach a fixed IP or a DHCP reservation so it can't move.
2. Leave **TCP Port** at 4998 and **IR Module Address** at 1 for an iTach.
3. After connecting, the log lists the modules the device reports. The selected IR module’s port count determines the port choices and presets. You can still enter a port number manually. If the module address doesn't point to an IR module, the connection shows a warning.

### Capturing IR codes

Download the free iLearn and iHelp utilities from [Global Caché Support Downloads](https://www.globalcache.com/downloads/). Mac versions are available from [http://www.rmartijnr.eu/](http://www.rmartijnr.eu/).

1. Select the device type you're learning from in the IR Learner dropdown menu (Autodetect Type).
2. Enter the IP address of the Global Caché device and press **Connect**.
3. Leave Capture Options at their defaults.
4. Point the remote at the IR learning receiver and press the button you want to capture.
5. Select the Global Caché format in the **Format** dropdown menu.
6. Press **Edit** to move the captured code into the Edit field, then copy it.

![iLearn](images/iLearn.jpg?raw=true 'iLearn')

Paste the code into the **Send IR code** action. These formats are accepted:

- Global Caché code (numeric or compressed): `38000,1,1,342,171,21,64,...`
- The full line from iLearn, including the header: `sendir,1:1,1,38000,1,1,...` (the header is removed automatically)
- Learned Pronto hex: `0000 006D 0022 0002 ...`

Codes saved with earlier versions of this module keep working. Spaces and line breaks are ignored. Codes are checked before sending, and problems are reported in the log and the `last_error` variable.

**Tip:** To reuse a code on many buttons, store it in a Companion custom variable and enter `$(internal:custom_projector_power)` as the IR code.

### Actions

- **Send IR code**: transmits a code on a port. The action completes once the iTach confirms the code was sent, so in a sequential action group the next step waits for it. Use _Repeat count_ for devices that need a code sent more than once to react.
- **Start IR hold**: sends short IR bursts for as long as the button is held. Pair it with **Stop IR** on release.
- **Stop IR**: discards waiting codes and asks the device to stop the active transmission. The module waits for the device’s acknowledgment. A device that does not acknowledge the stop, such as a GC-100, causes the module to reconnect.
- **Clear queued codes**: discards codes waiting on every port.
- **Reconnect**: drops and re-opens the connection.
- **Send raw command (advanced)**: sends a Global Caché API command. On a GC-100, wait for IR delivery to finish before sending a raw command. Find replies in the module log.

**Hold to repeat (e.g. volume):** use _Start IR hold_ on press and _Stop IR_ on release. The module refreshes a burst of three repeats while held. If the connection drops, the device can finish the remaining repeats in the last burst. Release and press the button again after reconnecting. For an older copied preset, replace its press action with _Start IR hold_ and keep the same IR code and release action.

### How delivery works

- Each port sends one code at a time and waits for the iTach to confirm it before sending the next, so a quick second press never cuts off the first code. Ports work independently.
- If another controller is using the port (_busyIR_), the code is retried automatically (see **Retries**).
- Codes pressed while the device is offline, or while another controller holds the port, are sent once it is free unless they have waited longer than **Discard codes not started within**. Time spent waiting behind a code this module is already sending does not count, so a button that sends several codes still sends them all. The limit keeps a power toggle from firing long after someone pressed it.
- If the connection drops while a code is sending, or no confirmation arrives, the code is **not** resent by default, because resending a toggle code (such as a single power button) would undo it. Enable **Also resend when delivery is unconfirmed** only if your codes are all discrete (e.g. separate Power On and Power Off codes).

### Recovery

- The connection is retried automatically, every second at first and backing off to every 5 seconds, until the device is back. Queued sends wait for identification and still expire according to **Discard codes not started within**.
- An idle connection is checked every 10 seconds by default (**Connection check interval**). This catches a device that lost power or network without closing the connection, so it reconnects before the next button press instead of failing.
- A missing confirmation also triggers an immediate connection check.

### Feedbacks and variables

- **Device connected**, **Port sending**, and **Last code failed** feedbacks.
- Variables: `connection_status`, `firmware_version`, `queue_depth`, `last_port`, `last_result`, `last_error`, `last_latency_ms`, `sent_total`, `failed_total`, `reconnects`.

The **Status** preset shows the connection state, turns red when a code fails, and reconnects when pressed. Each port has a group containing its **Send**, **Hold to repeat**, and **Stop** presets.

### Troubleshooting

- **"Frequency ... out of range"**: part of the `sendir,...` header is still in the code. Paste the whole line from iLearn or only the part starting at the frequency.
- **"on/off pairs" or "Offset" errors**: the code was cut off while copying. Copy it again from iLearn.
- **"Port is busy"**: another controller (an app, a second Companion) is using the port.
- **Codes are confirmed but the device doesn't react**: check the emitter placement, or try a _Repeat count_ of 2–3.
- **Wi-Fi (WF2IR) drops out**: increase **Response timeout**.
