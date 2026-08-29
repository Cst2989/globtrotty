// Tests replay recorded model responses, so a key is never needed here.
// When RECORD_MODEL=1 is set, the replay client records against the live API
// and needs ANTHROPIC_API_KEY from .env.local.
import 'dotenv/config'
import { config } from 'dotenv'

config({ path: '.env.local', override: false })
