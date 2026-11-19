import "fake-indexeddb/auto";
import { setLanguage } from "../src/i18n.js";

// Legacy regression fixtures exercise the original Chinese strings.
setLanguage("zh");
