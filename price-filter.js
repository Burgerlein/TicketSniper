// =============================================================================
// Läuft im Seitenkontext ("world": "MAIN"), weil nur dort jQuery und die
// ionRangeSlider-Instanz der Seite erreichbar sind. content.js schickt per
// postMessage den gewünschten Preis, dieses Script setzt den Slider darauf.
// =============================================================================

const SLIDER_SELECTOR = ".js-range-slider";

/** Normalisiert Preise wie "18,50 EUR" / "18.50" zu "18.50". */
function normalizePrice(text) {
  const match = String(text).replace(",", ".").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]).toFixed(2) : null;
}

function setPriceRange(price) {
  const $ = window.jQuery;
  const slider = $ && $(SLIDER_SELECTOR).data("ionRangeSlider");
  if (!slider) return { ok: false, reason: "Slider nicht gefunden" };

  // Der Slider arbeitet mit einer Werteliste; from/to sind Indizes darin
  const values = slider.options.values.length
    ? slider.options.values
    : $(SLIDER_SELECTOR).attr("data-formatted-values").split(";");
  const index = values.findIndex((v) => normalizePrice(v) === normalizePrice(price));
  if (index === -1) return { ok: false, reason: `Preis ${price} nicht im Slider`, values };

  slider.update({ from: index, to: index });

  // update() löst nur onUpdate aus – die Seite filtert aber evtl. erst bei onChange/onFinish
  const { onChange, onFinish } = slider.options;
  if (typeof onChange === "function") onChange(slider.result);
  if (typeof onFinish === "function") onFinish(slider.result);
  $(SLIDER_SELECTOR).trigger("change");

  return { ok: true, value: values[index] };
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== "auswahlHelfer:setPrice") return;

  let result;
  try {
    result = setPriceRange(event.data.price);
  } catch (e) {
    result = { ok: false, reason: e.message };
  }
  window.postMessage({ type: "auswahlHelfer:setPriceResult", ...result }, "*");
});
