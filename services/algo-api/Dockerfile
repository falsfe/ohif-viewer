FROM python:3.11-slim

WORKDIR /app

# build 时代理(apt-get / pip 走代理加速;由 docker-compose build.args 注入)
ARG HTTP_PROXY
ARG HTTPS_PROXY

# 系统依赖(torch / Pillow 需要)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# PyTorch CPU 版(比 GPU 小很多;肺部分割 TransUNet 用)
RUN pip install --no-cache-dir torch torchvision \
    --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
