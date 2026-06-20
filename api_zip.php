<?php
// api_zip.php — download ZIP / manifest (modulo di api.php, incluso dal dispatcher)
// ─── File: download ZIP (compressione) ───────────────────────────────────────
function action_zip(): void {
    require_login();
    $paths = $_GET['paths'] ?? [];
    if (is_string($paths)) $paths = [$paths];
    $paths = array_values(array_filter((array) $paths, fn($x) => $x !== ''));
    if (empty($paths)) json_out(['ok' => false, 'error' => 'Niente da comprimere'], 400);

    $logical = array_map(fn($rel) => user_path((string) $rel), $paths);
    $tmp = zip_logical($logical);   // zip via storage (Local o S3), confinato alla home utente
    $dlname = (count($logical) === 1) ? (basename($logical[0]) ?: 'cartella') . '.zip' : 'share-download.zip';
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . addslashes($dlname) . '"');
    header('Content-Length: ' . filesize($tmp));
    header('Cache-Control: no-store');
    readfile($tmp);
    @unlink($tmp);
    exit;
}

// ─── ZIP: manifest per il download diretto da S3 (client-zip) ────────────────
// Dato paths[] (relativi alla sandbox utente), espande ricorsivamente i file e,
// se il backend è S3 e l'archivio non è troppo grande, ritorna gli URL presigned
// per scaricarli DIRETTAMENTE da Wasabi (banda server ~zero). Con backend locale
// o oltre i limiti ritorna mode:'server' (il client userà il server-zip esistente).
function action_zip_manifest(): void {
    require_login();
    $paths = $_GET['paths'] ?? [];
    if (is_string($paths)) $paths = [$paths];
    $paths = array_values(array_filter((array) $paths, fn($x) => $x !== ''));
    if (empty($paths)) json_out(['ok' => false, 'error' => 'Niente da comprimere'], 400);

    $logical = array_map(fn($rel) => user_path((string) $rel), $paths);   // confinato alla home utente
    $zipname = (count($logical) === 1) ? (basename($logical[0]) ?: 'cartella') . '.zip' : 'share-download.zip';
    json_out(zip_manifest_build($logical, $zipname, ZIP_PRESIGN_TTL));
}

