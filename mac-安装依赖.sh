#!/bin/bash
cd "$(dirname "$0")"
echo "============================================"
echo "   Installing dependencies (offline)"
echo "============================================"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python not found. Please install Python 3.10+"
    echo "Download: https://www.python.org/downloads/"
    read -p "Press Enter to exit..."
    exit 1
fi

python3 --version

if [ ! -x .venv/bin/python ]; then
  echo "Creating project virtual environment..."
  python3 -m venv .venv || exit 1
fi
PYTHON=".venv/bin/python"

echo ""
echo "[1/2] Checking pip..."
${PYTHON} -m pip --version &> /dev/null
if [ $? -ne 0 ]; then
  echo "pip not found, bootstrapping..."
    ${PYTHON} -m ensurepip --upgrade
fi

echo "[2/2] Installing from local packages folder..."
${PYTHON} -m pip install --no-index --find-links=packages -r requirements.txt

if [ $? -ne 0 ]; then
    echo ""
    echo "[WARN] Offline install failed, trying online..."
    ${PYTHON} -m pip install -r requirements.txt
fi

echo ""
echo "Done. Run './启动服务.sh' to start."
read -p "Press Enter to exit..."
