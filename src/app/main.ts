import { EditorApp } from "./EditorApp";
import "../styles/styles.css";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Root #app mancante.");
}

const app = new EditorApp(root);

app.start().catch((error) => {
  console.error(error);
  root.textContent = "Errore durante l'avvio dell'editor.";
});
