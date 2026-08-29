use std::collections::BTreeMap;
use std::fs;

use blake2b_simd::Params;
use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::{SigHashReusedValuesUnsync, calc_schnorr_signature_hash};
use kaspa_consensus_core::hashing::sighash_type::SIG_HASH_ALL;
use kaspa_consensus_core::mass::units::SigopCount;
use kaspa_consensus_core::subnets::SUBNETWORK_ID_NATIVE;
use kaspa_consensus_core::tx::{CovenantBinding, PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput, UtxoEntry, VerifiableTransaction};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::covenants::CovenantsContext;
use kaspa_txscript::{EngineCtx, EngineFlags, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags};
use kaspa_txscript_errors::TxScriptError;
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
use silverscript_abi::{ArtifactValue, SilAbiArtifact, encode_contract_entry_sig_script, encode_runtime_state_script};

const POT: u64 = 200_000_000;
const STAKE: u64 = 100_000_000;
const DEADLINE_DAA: u64 = 500_000_000_000;

struct Player {
    keypair: Keypair,
    pubkey: Vec<u8>,
    hash: Vec<u8>,
}

#[test]
fn vm_accepts_late_fallback_claim_and_rejects_early_or_wrong_revealer() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let state = game_state(&artifact, 2, &creator, &joiner, 0, 0, &creator.hash);
    assert_spend(&artifact, &state, "fallback_claim", &creator, POT, DEADLINE_DAA + 3_000, true);
    assert_spend(&artifact, &state, "fallback_claim", &creator, POT, DEADLINE_DAA + 2_999, false);
    assert_spend(&artifact, &state, "fallback_claim", &joiner, POT, DEADLINE_DAA + 3_000, false);
}

#[test]
fn vm_accepts_player_refund_only_before_any_valid_reveal() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let joined = game_state(&artifact, 1, &creator, &joiner, 0, 0, &[]);
    let after_creator_refund = game_state_with_pot(&artifact, 5, &creator, &joiner, 0, 0, &[], STAKE);
    let after_joiner_refund = game_state_with_pot(&artifact, 6, &creator, &joiner, 0, 0, &[], STAKE);
    assert_refund_spend(&artifact, &joined, &creator, STAKE, DEADLINE_DAA + 3_000, Some(&after_creator_refund), true);
    assert_refund_spend(&artifact, &joined, &joiner, STAKE, DEADLINE_DAA + 3_000, Some(&after_joiner_refund), true);
    assert_refund_spend(&artifact, &joined, &creator, STAKE, DEADLINE_DAA + 2_999, Some(&after_creator_refund), false);

    assert_refund_spend(&artifact, &after_creator_refund, &joiner, STAKE, DEADLINE_DAA + 3_000, None, true);
    assert_refund_spend(&artifact, &after_creator_refund, &creator, STAKE, DEADLINE_DAA + 3_000, None, false);

    let revealed = game_state(&artifact, 2, &creator, &joiner, 1, 0, &creator.hash);
    assert_refund_spend(&artifact, &revealed, &creator, STAKE, DEADLINE_DAA + 3_000, None, false);
}

#[test]
fn vm_accepts_normal_reveals_and_rejects_invalid_reveals() {
    let artifact = artifact();
    let creator = player(1);
    let joiner = player(2);
    let creator_nonce = vec![7; 32];
    let joiner_nonce = vec![8; 32];
    let joined = game_state_with_commits(&artifact, 1, &creator, &joiner, 0, 0, &[], &commitment(1, &creator_nonce), &commitment(0, &joiner_nonce), POT);
    let after_creator_reveal = game_state_with_commits(&artifact, 2, &creator, &joiner, 1, 0, &creator.hash, &commitment(1, &creator_nonce), &commitment(0, &joiner_nonce), POT);

    assert_reveal_spend(&artifact, &joined, &creator, 1, &creator_nonce, Some(&after_creator_reveal), vec![], true);
    assert_reveal_spend(&artifact, &joined, &creator, 0, &creator_nonce, Some(&after_creator_reveal), vec![], false);
    assert_reveal_spend(&artifact, &game_state(&artifact, 0, &creator, &joiner, 0, 0, &[]), &creator, 1, &creator_nonce, None, vec![], false);
    assert_reveal_spend(&artifact, &after_creator_reveal, &creator, 1, &creator_nonce, None, vec![], false);

    assert_reveal_spend(
        &artifact,
        &after_creator_reveal,
        &joiner,
        0,
        &joiner_nonce,
        None,
        vec![
            TransactionOutput { value: POT, script_public_key: ScriptPublicKey::new(0, vec![0x51].into()), covenant: None },
            TransactionOutput { value: STAKE, script_public_key: ScriptPublicKey::new(0, vec![0x52].into()), covenant: None },
        ],
        true,
    );
    assert_reveal_spend(
        &artifact,
        &after_creator_reveal,
        &joiner,
        0,
        &joiner_nonce,
        None,
        vec![
            TransactionOutput { value: STAKE, script_public_key: ScriptPublicKey::new(0, vec![0x51].into()), covenant: None },
            TransactionOutput { value: POT, script_public_key: ScriptPublicKey::new(0, vec![0x52].into()), covenant: None },
        ],
        false,
    );
}

fn assert_reveal_spend(artifact: &SilAbiArtifact, state_script: &[u8], player: &Player, choice: i64, nonce: &[u8], continuation_state: Option<&[u8]>, outputs: Vec<TransactionOutput>, should_pass: bool) {
    let script = instance_script(artifact, state_script);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let placeholder = entry_sigscript(artifact, "reveal", vec![ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Bytes(player.pubkey.clone()), ArtifactValue::Int(choice), ArtifactValue::Bytes(nonce.to_vec())], &script);
    let entries = vec![UtxoEntry::new(POT, pay_to_script_hash_script(&script), DEADLINE_DAA, false, Some(covenant_id))];
    let tx_outputs = if let Some(next_state) = continuation_state {
        let next_script = instance_script(artifact, next_state);
        vec![TransactionOutput {
            value: POT,
            script_public_key: pay_to_script_hash_script(&next_script),
            covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id }),
        }]
    } else {
        outputs
    };
    let mut tx = Transaction::new(1, vec![tx_input(0, placeholder)], tx_outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let sig = sign_tx_input(&tx, &entries, 0, player);
    tx.inputs[0].signature_script = entry_sigscript(artifact, "reveal", vec![ArtifactValue::Bytes(sig), ArtifactValue::Bytes(player.pubkey.clone()), ArtifactValue::Int(choice), ArtifactValue::Bytes(nonce.to_vec())], &script);
    let result = execute_input(tx, entries, 0);
    if should_pass {
        assert!(result.is_ok(), "reveal should pass: {:?}", result.err());
    } else {
        assert!(matches!(result, Err(TxScriptError::VerifyError | TxScriptError::EvalFalse | TxScriptError::UnsatisfiedLockTime(_))), "reveal should fail by VM verify/eval false: {result:?}");
    }
}

fn assert_refund_spend(artifact: &SilAbiArtifact, state_script: &[u8], player: &Player, payout: u64, daa: u64, continuation_state: Option<&[u8]>, should_pass: bool) {
    assert_spend_with_outputs(artifact, state_script, "refund_player", player, daa, should_pass, |script, covenant_id| {
        let mut outputs = vec![TransactionOutput { value: payout, script_public_key: ScriptPublicKey::new(0, vec![0x51].into()), covenant: None }];
        if let Some(next_state) = continuation_state {
            let next_script = instance_script(artifact, next_state);
            outputs.push(TransactionOutput {
                value: STAKE,
                script_public_key: pay_to_script_hash_script(&next_script),
                covenant: Some(CovenantBinding { authorizing_input: 0, covenant_id }),
            });
        }
        let _ = script;
        outputs
    });
}

fn assert_spend(artifact: &SilAbiArtifact, state_script: &[u8], entry: &str, player: &Player, payout: u64, daa: u64, should_pass: bool) {
    assert_spend_with_outputs(artifact, state_script, entry, player, daa, should_pass, |_script, _covenant_id| {
        vec![TransactionOutput { value: payout, script_public_key: ScriptPublicKey::new(0, vec![0x51].into()), covenant: None }]
    });
}

fn assert_spend_with_outputs<F>(artifact: &SilAbiArtifact, state_script: &[u8], entry: &str, player: &Player, daa: u64, should_pass: bool, build_outputs: F)
where
    F: FnOnce(&[u8], Hash) -> Vec<TransactionOutput>,
{
    let script = instance_script(artifact, state_script);
    let covenant_id = Hash::from_bytes([0x33; 32]);
    let placeholder = entry_sigscript(artifact, entry, vec![ArtifactValue::Bytes(vec![0; 65]), ArtifactValue::Bytes(player.pubkey.clone())], &script);
    let entries = vec![UtxoEntry::new(POT, pay_to_script_hash_script(&script), DEADLINE_DAA, false, Some(covenant_id))];
    let outputs = build_outputs(&script, covenant_id);
    let age_daa = daa.checked_sub(DEADLINE_DAA).expect("test daa is after input daa");
    let mut input = tx_input(0, placeholder);
    input.sequence = age_daa;
    let mut tx = Transaction::new(1, vec![input], outputs, 0, SUBNETWORK_ID_NATIVE, 0, vec![]);
    let sig = sign_tx_input(&tx, &entries, 0, player);
    tx.inputs[0].signature_script = entry_sigscript(artifact, entry, vec![ArtifactValue::Bytes(sig), ArtifactValue::Bytes(player.pubkey.clone())], &script);
    let result = execute_input(tx, entries, 0);
    if should_pass {
        assert!(result.is_ok(), "{entry} should pass: {:?}", result.err());
    } else {
        assert!(matches!(result, Err(TxScriptError::VerifyError | TxScriptError::EvalFalse | TxScriptError::UnsatisfiedLockTime(_))), "{entry} should fail by VM verify/eval false: {result:?}");
    }
}

fn artifact() -> SilAbiArtifact {
    let raw = fs::read_to_string("../covenant/even_odd.template.artifact.json").expect("artifact readable");
    let artifact: SilAbiArtifact = serde_json::from_str(&raw).expect("artifact parses");
    artifact.verify().expect("artifact verifies");
    artifact
}

fn game_state(artifact: &SilAbiArtifact, status: i64, creator: &Player, joiner: &Player, creator_choice: i64, joiner_choice: i64, first_revealer_hash: &[u8]) -> Vec<u8> {
    game_state_with_pot(artifact, status, creator, joiner, creator_choice, joiner_choice, first_revealer_hash, POT)
}

fn game_state_with_pot(artifact: &SilAbiArtifact, status: i64, creator: &Player, joiner: &Player, creator_choice: i64, joiner_choice: i64, first_revealer_hash: &[u8], pot: u64) -> Vec<u8> {
    game_state_with_commits(artifact, status, creator, joiner, creator_choice, joiner_choice, first_revealer_hash, &vec![9; 32], &vec![8; 32], pot)
}

fn game_state_with_commits(artifact: &SilAbiArtifact, status: i64, creator: &Player, joiner: &Player, creator_choice: i64, joiner_choice: i64, first_revealer_hash: &[u8], creator_commit: &[u8], joiner_commit: &[u8], pot: u64) -> Vec<u8> {
    let contract = artifact.contract("EvenOdd").expect("EvenOdd contract");
    let mut values = BTreeMap::new();
    values.insert("creator_hash".into(), ArtifactValue::Bytes(creator.hash.clone()));
    values.insert("joiner_hash".into(), ArtifactValue::Bytes(joiner.hash.clone()));
    values.insert("creator_commit".into(), ArtifactValue::Bytes(creator_commit.to_vec()));
    values.insert("joiner_commit".into(), ArtifactValue::Bytes(joiner_commit.to_vec()));
    values.insert("pot".into(), ArtifactValue::Int(pot as i64));
    values.insert("deadline_daa".into(), ArtifactValue::Int(DEADLINE_DAA as i64));
    values.insert("creator_even".into(), ArtifactValue::Int(1));
    values.insert("creator_choice".into(), ArtifactValue::Int(creator_choice));
    values.insert("joiner_choice".into(), ArtifactValue::Int(joiner_choice));
    values.insert("first_revealer_hash".into(), ArtifactValue::Bytes(if first_revealer_hash.is_empty() { vec![0; 32] } else { first_revealer_hash.to_vec() }));
    values.insert("status".into(), ArtifactValue::Int(status));
    encode_runtime_state_script(artifact, &contract.runtime_state, &values).expect("state encodes")
}

fn commitment(choice: i64, nonce: &[u8]) -> Vec<u8> {
    let mut preimage = Vec::new();
    preimage.extend_from_slice(&choice.to_le_bytes());
    preimage.extend_from_slice(nonce);
    blake2b256(&preimage).to_vec()
}

fn instance_script(artifact: &SilAbiArtifact, state_script: &[u8]) -> Vec<u8> {
    let (_, contract) = artifact.contracts.first_key_value().expect("single contract");
    let (prefix, _, suffix) = contract.compiled.script_parts(&contract.compiled.bytecode).expect("script parts");
    let mut out = Vec::new();
    out.extend_from_slice(prefix);
    out.extend_from_slice(state_script);
    out.extend_from_slice(suffix);
    out
}

fn entry_sigscript(artifact: &SilAbiArtifact, entry: &str, args: Vec<ArtifactValue>, script: &[u8]) -> Vec<u8> {
    let contract_name = artifact.contracts.first_key_value().expect("single contract").0;
    let call = encode_contract_entry_sig_script(artifact, contract_name, entry, &args).expect("entry encodes");
    pay_to_script_hash_signature_script_with_flags(script.to_vec(), call, EngineFlags { covenants_enabled: true, ..Default::default() }).expect("p2sh wraps")
}

fn tx_input(index: u32, signature_script: Vec<u8>) -> TransactionInput {
    TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([index as u8 + 1; 32]), index },
        signature_script,
        sequence: 0,
        compute_commit: SigopCount(20).into(),
    }
}

fn sign_tx_input(tx: &Transaction, entries: &[UtxoEntry], input_idx: usize, player: &Player) -> Vec<u8> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let populated = PopulatedTransaction::new(tx, entries.to_vec());
    let sig_hash = calc_schnorr_signature_hash(&populated, input_idx, SIG_HASH_ALL, &reused_values);
    let msg = Message::from_digest_slice(sig_hash.as_bytes().as_slice()).expect("valid sighash");
    let sig = player.keypair.sign_schnorr(msg);
    let mut out = Vec::new();
    out.extend_from_slice(sig.as_ref());
    out.push(SIG_HASH_ALL.to_u8());
    out
}

fn execute_input(tx: Transaction, entries: Vec<UtxoEntry>, input_idx: usize) -> Result<(), TxScriptError> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let input = tx.inputs[input_idx].clone();
    let populated = PopulatedTransaction::new(&tx, entries);
    let cov_ctx = CovenantsContext::from_tx(&populated).map_err(TxScriptError::from)?;
    let utxo = populated.utxo(input_idx).expect("selected input utxo");
    TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        input_idx,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values).with_covenants_ctx(&cov_ctx),
        EngineFlags { covenants_enabled: true, ..Default::default() },
    ).execute()
}

fn player(seed: u8) -> Player {
    let secp = Secp256k1::new();
    let secret = SecretKey::from_slice(&[seed; 32]).expect("valid secret");
    let keypair = Keypair::from_secret_key(&secp, &secret);
    let (xonly, _) = keypair.x_only_public_key();
    let pubkey = xonly.serialize().to_vec();
    let hash = blake2b256(&pubkey).to_vec();
    Player { keypair, pubkey, hash }
}

fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let h = Params::new().hash_length(32).to_state().update(data).finalize();
    out.copy_from_slice(h.as_bytes());
    out
}
