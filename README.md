# DockSentinelAgent

DockSentinelAgent e o runtime remoto do DockSentinel para controlar um Docker Engine em outro host.

## Requisitos

- Docker Engine acessivel pelo socket `/var/run/docker.sock`
- Porta padrao `45873`
- Diretorio persistente para o estado local do agent em `/var/lib/docksentinel-agent`
- Pareamento inicial feito pela pagina local `/setup` com o bootstrap token gerado pela instancia principal do DockSentinel

## Execucao manual

```bash
docker run -d \
  --name docksentinel-agent \
  --restart unless-stopped \
  -p 45873:45873 \
  -e PORT=45873 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/docksentinel-agent:/var/lib/docksentinel-agent \
  leufrasiojunior/docksentinel-agent:latest
```

## Desenvolvimento

```bash
npm install
npm run build
```

## Setup e rotacao de token

- No primeiro pareamento, suba o container e abra `http://HOST:45873/setup`.
- Cole o bootstrap token mostrado pelo DockSentinel principal e volte ao app principal.
- O DockSentinel principal monitora o setup e conclui automaticamente quando o agent estiver pronto, mas tambem oferece o botao `Complete setup`.
- Quando houver rotacao, o fluxo reaproveita a mesma pagina `/setup`.

## Observacoes

- O agent nao possui banco nem auth de usuarios. A unica UI embutida e a pagina local de setup em `/setup`, exposta apenas enquanto o agent estiver sem pareamento ou com rotacao pendente.
- O startup faz um preflight e encerra com `exit 1` se detectar o DockSentinel principal no mesmo host.
- A API HTTP permanece em `/agent/v1/...` para manter compatibilidade com o servidor principal.
