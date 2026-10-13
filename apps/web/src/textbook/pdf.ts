import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { GlobalWorkerOptions, pageRenderer, parsePdf } from "@kj/pdf-structure/browser";

GlobalWorkerOptions.workerSrc = workerUrl;

/** pdf.js in the browser, configured once; the only place the web app loads it. */
export { pageRenderer, parsePdf };
