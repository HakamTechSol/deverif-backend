import net from "net";
import fs from "fs";

const PORT = 2525;
const OUT = "./dev-smtp-inbox.jsonl";

net.createServer((socket) => {
  let buf = "";
  const state = { from: null, to: [], data: [], inData: false };

  socket.write("220 localhost SMTP catcher ready\r\n");

  socket.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\r\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleLine(line);
    }
  });

  function handleLine(line) {
    if (state.inData) {
      if (line === ".") {
        const message = state.data.join("\r\n");
        const otpMatch = message.match(/\b(\d{6})\b/);
        const record = {
          ts: new Date().toISOString(),
          from: state.from,
          to: state.to,
          otp: otpMatch ? otpMatch[1] : null,
          subject: (message.match(/Subject: ([^\r\n]*)/) || [])[1] || "",
          body: message,
        };
        try { fs.appendFileSync(OUT, JSON.stringify(record) + "\n"); } catch {}
        console.log(`[SMTP] mail to=${state.to.join(",")} subject="${record.subject}" otp=${record.otp}`);
        state.inData = false;
        state.data = [];
        socket.write("250 OK queued\r\n");
        return;
      }
      state.data.push(line.replace(/^\.\./, "."));
      return;
    }
    const cmd = line.toUpperCase();
    if (cmd.startsWith("EHLO")) {
      socket.write("250-localhost\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n");
    } else if (cmd.startsWith("HELO")) {
      socket.write("250 localhost\r\n");
    } else if (cmd.startsWith("MAIL FROM")) {
      state.from = line.split(":").slice(1).join(":").trim() || "";
      socket.write("250 OK\r\n");
    } else if (cmd.startsWith("RCPT TO")) {
      state.to.push(line.split(":").slice(1).join(":").trim() || "");
      socket.write("250 OK\r\n");
    } else if (cmd.startsWith("DATA")) {
      state.inData = true;
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
    } else if (cmd.startsWith("QUIT")) {
      socket.write("221 Bye\r\n");
      socket.end();
    } else {
      // RSET, NOOP, AUTH, STARTTLS-anything else: accept generically
      socket.write(cmd.startsWith("AUTH") ? "235 Authentication successful\r\n" : "250 OK\r\n");
    }
  }

  socket.on("error", () => {});
}).listen(PORT, () => console.log(`[SMTP] catcher listening on :${PORT}, writing to ${OUT}`));
