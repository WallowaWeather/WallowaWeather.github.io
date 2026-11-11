// places/neutralise.js - untrusted text from the network (NWS alerts and forecasts) never carries chat-template control tokens:
// every <|...> / <...|> marker and the plain-word controls (<bos>, <eos>, <pad>, <mask>, <unk>) become a space.
export function neutralise(text) {
  return String(text || '').replace(/<\|?\s*"?\s*\|>|<\|[^<>\n]{0,40}>|<[^<>\n]{0,40}\|>|<(?:bos|eos|pad|mask|unk|start_of_turn|end_of_turn)>/gi, ' ');
}
