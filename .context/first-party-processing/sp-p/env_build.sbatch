#!/usr/bin/env bash
#SBATCH --job-name=spp-env
#SBATCH --account=<ACCOUNT>
#SBATCH --partition=debug
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=24G
#SBATCH --time=00:28:00
#SBATCH --constraint="lustre"
#SBATCH --no-requeue
#SBATCH --output=<SPIKE_ROOT>/logs/%x-%j.out
#SBATCH --error=<SPIKE_ROOT>/logs/%x-%j.out
# SP-P environment build, on a compute node (never the login node).
# Two venvs: venvs/cpu (CPU torch) and venvs/gpu (CUDA torch that has sm_70 kernels, because
# Expanse V100s are Volta and CUDA 13 wheels dropped it), plus the pamica native binary and
# the real ds002718 recording as .npy. Install torch ALONE from its index first, then the rest
# (eeg-frontends/docs/expanse/README.md section 4: mixing generations breaks NCCL symbols).
set -uo pipefail
ROOT=<SPIKE_ROOT>
export PATH=$HOME/.local/bin:$PATH
export UV_CACHE_DIR=<SPIKE_PARENT>/.uv-cache
cd "$ROOT" || exit 1
hostname; date
curl -sS -m 15 -o /dev/null -w "pypi http %{http_code}\n" https://pypi.org/simple/uv/ || { echo "NO_NET: compute node cannot reach pypi"; exit 3; }
curl -sS -m 15 -o /dev/null -w "pytorch http %{http_code}\n" https://download.pytorch.org/whl/cu128/ || echo "WARN: pytorch index unreachable"
curl -sS -m 15 -o /dev/null -w "github http %{http_code}\n" https://github.com/sccn/pAMICA/releases || echo "WARN: github unreachable (native binary download will fail)"
if ! command -v uv >/dev/null; then curl -LsSf https://astral.sh/uv/install.sh | sh; fi
uv --version
uv python install 3.13

REST="numpy scipy matplotlib tqdm json5 threadpoolctl mne"

# ---- CPU venv
uv venv --python 3.13 venvs/cpu
uv pip install --python venvs/cpu/bin/python --index-url https://download.pytorch.org/whl/cpu "torch>=2.12.1"
uv pip install --python venvs/cpu/bin/python $REST "pamica==0.4.0"
venvs/cpu/bin/python -c "import torch,pamica;print('cpu venv: torch',torch.__version__,'pamica',pamica.__version__)"

# ---- GPU venv: newest cu128 torch >= 2.12.1, must contain sm_70
has_sm70() { local lib; lib=$(ls "$1"/lib/python*/site-packages/torch/lib/libtorch_cuda.so 2>/dev/null | head -1); [ -n "$lib" ] && strings -a "$lib" | grep -qw sm_70; }
uv venv --python 3.13 venvs/gpu
if uv pip install --python venvs/gpu/bin/python --index-url https://download.pytorch.org/whl/cu128 "torch>=2.12.1" && has_sm70 venvs/gpu; then
  echo "GPU_TORCH_OK: cu128 torch>=2.12.1 has sm_70"
  uv pip install --python venvs/gpu/bin/python $REST "pamica==0.4.0"
else
  echo "GPU_TORCH_NO_SM70: falling back to torch 2.8.0+cu128 with pamica --no-deps (pamica pins torch>=2.12.1, untested below that)"
  rm -rf venvs/gpu; uv venv --python 3.13 venvs/gpu
  uv pip install --python venvs/gpu/bin/python --index-url https://download.pytorch.org/whl/cu128 "torch==2.8.0"
  uv pip install --python venvs/gpu/bin/python $REST
  uv pip install --python venvs/gpu/bin/python --no-deps "pamica==0.4.0"
  has_sm70 venvs/gpu && echo "GPU_TORCH_FALLBACK_OK" || echo "GPU_TORCH_FALLBACK_FAILED"
fi
venvs/gpu/bin/python -c "import torch,pamica;print('gpu venv: torch',torch.__version__,'cuda',torch.version.cuda,'pamica',pamica.__version__)"
uv pip list --python venvs/gpu/bin/python 2>/dev/null | awk '/^nvidia-/{print $1}' | grep -v -- '-cu12$' | sed 's/^/MIXED_CUDA_GENERATION: /'

# ---- native Fortran binary (pamica release asset; single process, OpenMP, no MPI)
venvs/cpu/bin/python -c "
from pamica.native import resolver
p = resolver.resolve('latest'); print('NATIVE', p)
open('$ROOT/native_binary.txt','w').write(str(p))
"
cat native_binary.txt 2>/dev/null && file "$(cat native_binary.txt)" | head -1

# ---- real recording: ds002718 sub-002 (NEMAR NFS mirror), 70 EEG channels, microvolts
# NEMAR_PROJECT_DIR: the cluster project directory that holds the openneuro mirror (set by the caller).
mkdir -p data
venvs/cpu/bin/python - <<'PY'
import mne, numpy as np
import os
src = os.environ["NEMAR_PROJECT_DIR"] + "/openneuro/ds002718/sub-002/eeg/sub-002_task-FaceRecognition_eeg.set"
raw = mne.io.read_raw_eeglab(src, preload=True, verbose="ERROR")
x = raw.get_data(picks=raw.ch_names[:70]) * 1e6
print("ds002718 sub-002", x.shape, "sfreq", raw.info["sfreq"])
np.save("data/ds002718_sub-002_eeg70_full.npy", x.astype(np.float64))
PY
ls -la data venvs; date
