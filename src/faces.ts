/**
 * Author pictures.
 *
 * - A picture you set yourself is stored on this machine and needs no network.
 * - "Online" pictures are opt-in: they come from GitHub (for GitHub no-reply
 *   addresses, which contain the account id) or from Gravatar, which is sent a
 *   SHA-256 hash of the author's email address.
 */
const GITHUB_NOREPLY = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i;
const gravatarCache = new Map<string, Promise<string>>();

export function onlinePicture(email: string, size: number): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e) return Promise.resolve(null);
  const gh = GITHUB_NOREPLY.exec(e);
  const px = Math.min(256, size * 2);
  if (gh) return Promise.resolve(`https://avatars.githubusercontent.com/u/${gh[1]}?s=${px}`);
  let hash = gravatarCache.get(e);
  if (!hash) {
    hash = crypto.subtle.digest("SHA-256", new TextEncoder().encode(e)).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
    gravatarCache.set(e, hash);
  }
  // d=404: no picture registered means "fall back to initials", never a generated image
  return hash.then((h) => `https://www.gravatar.com/avatar/${h}?s=${px}&d=404`, () => null);
}

/** Lets the user choose an image file and returns it as a small square PNG data URL. */
export function pickPicture(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file || file.size > 20 * 1024 * 1024) return resolve(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        // Re-encode through a canvas: whatever the file was, only pixels are kept.
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 96;
        canvas.getContext("2d")?.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}
