# Laura — Assistente Virtual da Colares Engenharia

Sistema de atendimento WhatsApp 24/7 com 6 agentes de IA especializados.

## Pré-requisitos

- Node.js 22+
- Conta na Z-API (WhatsApp)
- Conta de serviço Google (Sheets + Calendar)
- Chave da API Anthropic (Claude)
- Conta no Railway (para deploy em nuvem)

## Instalação local

```bash
npm install
cp .env.example .env
# Preencha o .env com suas chaves
npm run dev
```

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

| Variável | Descrição |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API Claude (Anthropic) |
| `ZAPI_INSTANCE_ID` | ID da instância Z-API |
| `ZAPI_TOKEN` | Token da instância Z-API |
| `ZAPI_CLIENT_TOKEN` | Client token da Z-API |
| `GOOGLE_SHEETS_ID` | ID da planilha Google Sheets (CRM) |
| `GOOGLE_CALENDAR_ID` | ID da agenda Google Calendar |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | JSON da conta de serviço Google (em uma linha) |

## Endpoints

- `GET /health` — Healthcheck (retorna `{"status":"ok"}`)
- `POST /webhook` — Recebe mensagens da Z-API

## Arquitetura dos agentes

```
Triador → classifica o estágio do lead
Recepção → primeiro contato, coleta nome
Qualificador → coleta localização, tipo de imóvel, problema, urgência
Técnico → responde dúvidas técnicas com autoridade
Agendador → marca visita técnica
Guardião → salva lead no Sheets e cria evento no Calendar
```

## Deploy no Railway

1. Crie uma conta em https://railway.app
2. Conecte seu repositório GitHub
3. Adicione as variáveis de ambiente no painel do Railway
4. O deploy é automático a cada push
5. Pegue a URL pública gerada e configure como webhook na Z-API:
   `https://sua-url.railway.app/webhook`
