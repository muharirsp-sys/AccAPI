# Tujuan: Konfigurasi PyInstaller untuk membundel Dashboard Generator desktop.
# Caller: `python -m PyInstaller DashboardGenerator.spec --noconfirm --clean`.
# Dependensi: app.py, index.html, assets/echarts.min.js, pandas, pywebview, xlrd, openpyxl.
# Main Functions: Analysis, PYZ, EXE build graph untuk output DashboardGenerator.exe.
# Side Effects: Membuat folder build/ dan dist/ berisi executable hasil bundling.
from PyInstaller.utils.hooks import collect_submodules


block_cipher = None

hiddenimports = (
    collect_submodules("webview")
    + collect_submodules("xlrd")
    + collect_submodules("openpyxl")
)

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=[],
    datas=[("index.html", "."), ("assets/echarts.min.js", "assets")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib", "notebook", "pytest", "samples", "reference"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="DashboardGenerator",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
