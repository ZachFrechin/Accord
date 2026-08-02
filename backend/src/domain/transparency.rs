//! Key-transparency log — verifiable append-only Merkle tree (Phase 3 · Lot 6).
//!
//! The residual trust in Phase 3 is the Authentication Service: clients accept the
//! `BasicCredential` (identity↔key binding) the server hands them. A malicious
//! server could equivocate — give victim A a substituted key for B — undetectably.
//! Key transparency removes that trust: the server publishes an append-only,
//! auditable log of every identity↔key binding, and clients verify two things
//! against the log's signed head:
//!   * **inclusion** — my counterpart's key really is the one in the log, and
//!   * **consistency** — the log the server shows me now is an append-only
//!     extension of the one it showed me before (no history was rewritten).
//!
//! Gossiping the log head out-of-band then makes any equivocation detectable.
//!
//! This module is the crypto core: an [RFC 6962] (Certificate Transparency) Merkle
//! tree with Merkle Tree Hash, audit (inclusion) paths, and consistency proofs,
//! plus stateless verifiers a client re-implements. Storage of the log and the
//! signed tree head, and wiring the leaf to `device_keys`, are a later step;
//! [`binding_leaf`] fixes the leaf encoding so both ends agree.
//!
//! [RFC 6962]: https://www.rfc-editor.org/rfc/rfc6962#section-2

use sha2::{Digest, Sha256};

/// A 32-byte SHA-256 digest (a tree node / leaf hash).
pub type Hash = [u8; 32];

/// RFC 6962 leaf hash: `SHA-256(0x00 || data)`. The `0x00` prefix domain-separates
/// leaves from interior nodes so a leaf can never be reinterpreted as a subtree.
pub fn hash_leaf(data: &[u8]) -> Hash {
    let mut h = Sha256::new();
    h.update([0x00]);
    h.update(data);
    h.finalize().into()
}

/// RFC 6962 interior node hash: `SHA-256(0x01 || left || right)`.
fn hash_node(left: &Hash, right: &Hash) -> Hash {
    let mut h = Sha256::new();
    h.update([0x01]);
    h.update(left);
    h.update(right);
    h.finalize().into()
}

/// The hash of the empty tree: `SHA-256("")`, per RFC 6962.
fn empty_root() -> Hash {
    Sha256::new().finalize().into()
}

/// The largest power of two strictly smaller than `n` (n > 1). RFC 6962 splits a
/// subtree of `n` leaves at this point.
fn split(n: usize) -> usize {
    debug_assert!(n > 1);
    // 2^floor(log2(n-1)): the highest set bit of n-1.
    1usize << (usize::BITS - 1 - (n as u64 - 1).leading_zeros())
}

/// Merkle Tree Hash of a slice of leaf hashes (RFC 6962 §2.1). `leaves` are already
/// leaf hashes ([`hash_leaf`] outputs), so a single-leaf tree hashes to that leaf.
fn mth(leaves: &[Hash]) -> Hash {
    match leaves.len() {
        0 => empty_root(),
        1 => leaves[0],
        n => {
            let k = split(n);
            hash_node(&mth(&leaves[..k]), &mth(&leaves[k..]))
        }
    }
}

/// An append-only log of leaf hashes. Cheap to hold in memory for proof generation
/// (production would persist the leaves + cache subtree hashes).
#[derive(Debug, Default, Clone)]
pub struct MerkleLog {
    leaves: Vec<Hash>,
}

impl MerkleLog {
    /// In-memory constructor (used by tests + potential future in-process use; the
    /// backend serves proofs from a DB-rebuilt log via [`Self::from_leaf_hashes`]).
    #[allow(dead_code)]
    pub fn new() -> Self {
        Self { leaves: Vec::new() }
    }

    /// Append a leaf in memory (test/in-process; production appends via the repo).
    #[allow(dead_code)]
    pub fn append(&mut self, data: &[u8]) -> usize {
        self.leaves.push(hash_leaf(data));
        self.leaves.len() - 1
    }

    /// Rebuild a log from its persisted leaf hashes (already [`hash_leaf`] outputs),
    /// in append order — used to serve proofs from the stored log.
    pub fn from_leaf_hashes(leaves: Vec<Hash>) -> Self {
        Self { leaves }
    }

    /// The 0-based index of a leaf hash in the log, or `None` if absent.
    pub fn index_of(&self, leaf: &Hash) -> Option<usize> {
        self.leaves.iter().position(|h| h == leaf)
    }

    /// Number of leaves (the "tree size" a signed head commits to).
    pub fn size(&self) -> usize {
        self.leaves.len()
    }

    /// Current Merkle Tree Hash (the root a signed tree head would sign).
    pub fn root(&self) -> Hash {
        mth(&self.leaves)
    }

    /// Audit path proving leaf `index` is in the current tree (RFC 6962 §2.1.1).
    /// `None` if `index` is out of range.
    pub fn inclusion_proof(&self, index: usize) -> Option<Vec<Hash>> {
        if index >= self.leaves.len() {
            return None;
        }
        Some(path(index, &self.leaves))
    }

    /// Consistency proof that the current tree is an append-only extension of its
    /// prefix of `old_size` leaves (RFC 6962 §2.1.2). `None` if `old_size` is 0 or
    /// greater than the current size.
    pub fn consistency_proof(&self, old_size: usize) -> Option<Vec<Hash>> {
        if old_size == 0 || old_size > self.leaves.len() {
            return None;
        }
        Some(subproof(old_size, &self.leaves, true))
    }
}

/// RFC 6962 PATH(m, D): the audit path for leaf `m` in the tree over leaf hashes `d`.
fn path(m: usize, d: &[Hash]) -> Vec<Hash> {
    let n = d.len();
    if n == 1 {
        return Vec::new();
    }
    let k = split(n);
    if m < k {
        let mut p = path(m, &d[..k]);
        p.push(mth(&d[k..]));
        p
    } else {
        let mut p = path(m - k, &d[k..]);
        p.push(mth(&d[..k]));
        p
    }
}

/// RFC 6962 SUBPROOF(m, D, b): the consistency proof between the prefix of `m`
/// leaves and the whole of `d`.
fn subproof(m: usize, d: &[Hash], b: bool) -> Vec<Hash> {
    let n = d.len();
    if m == n {
        // The old tree is a whole subtree of the new one: only prove its hash when
        // the caller doesn't already know it (b == false → not the original root).
        return if b { Vec::new() } else { vec![mth(d)] };
    }
    let k = split(n);
    if m <= k {
        let mut p = subproof(m, &d[..k], b);
        p.push(mth(&d[k..]));
        p
    } else {
        let mut p = subproof(m - k, &d[k..], false);
        p.push(mth(&d[..k]));
        p
    }
}

/// Verify an audit path: recompute the tree root of size `size` from the claimed
/// `leaf` hash at `index` and the `proof`, and compare to `root`. Stateless — a
/// client runs exactly this against a signed tree head (RFC 9162 §2.1.3.2). The
/// backend generates proofs rather than verifying them, so this is a tested
/// reference the TypeScript client mirrors.
#[allow(dead_code)]
pub fn verify_inclusion(
    leaf: &Hash,
    index: usize,
    size: usize,
    root: &Hash,
    proof: &[Hash],
) -> bool {
    if index >= size {
        return false;
    }
    let mut fnn = index; // node's index within its level
    let mut sn = size - 1; // last node's index within its level
    let mut r = *leaf;
    for p in proof {
        if sn == 0 {
            return false; // proof longer than the path to the root
        }
        if fnn & 1 == 1 || fnn == sn {
            r = hash_node(p, &r);
            if fnn & 1 == 0 {
                while fnn & 1 == 0 && fnn != 0 {
                    fnn >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            r = hash_node(&r, p);
        }
        fnn >>= 1;
        sn >>= 1;
    }
    sn == 0 && &r == root
}

/// Verify a consistency proof: the size-`new_size` tree with root `new_root` is an
/// append-only extension of the size-`old_size` tree with root `old_root` — no
/// entry the old tree committed to was changed or removed. Stateless (RFC 9162
/// §2.1.4.2). Tested reference the TypeScript client mirrors (the backend generates
/// proofs, not verifies them).
#[allow(dead_code)]
pub fn verify_consistency(
    old_size: usize,
    new_size: usize,
    old_root: &Hash,
    new_root: &Hash,
    proof: &[Hash],
) -> bool {
    if old_size > new_size {
        return false;
    }
    if old_size == new_size {
        return proof.is_empty() && old_root == new_root;
    }
    if old_size == 0 {
        return proof.is_empty(); // every tree extends the empty tree
    }

    // If old_size is a power of two, old_root is the implicit first proof node.
    let mut path: Vec<Hash> = Vec::with_capacity(proof.len() + 1);
    if old_size.is_power_of_two() {
        path.push(*old_root);
    }
    path.extend_from_slice(proof);
    if path.is_empty() {
        return false;
    }

    let mut fnn = old_size - 1;
    let mut sn = new_size - 1;
    while fnn & 1 == 1 {
        fnn >>= 1;
        sn >>= 1;
    }
    let mut fr = path[0];
    let mut sr = path[0];
    for c in &path[1..] {
        if sn == 0 {
            return false;
        }
        if fnn & 1 == 1 || fnn == sn {
            fr = hash_node(c, &fr);
            sr = hash_node(c, &sr);
            if fnn & 1 == 0 {
                while fnn & 1 == 0 && fnn != 0 {
                    fnn >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            sr = hash_node(&sr, c);
        }
        fnn >>= 1;
        sn >>= 1;
    }
    sn == 0 && &fr == old_root && &sr == new_root
}

/// Canonical leaf encoding for an identity↔key binding, so the server and every
/// verifying client hash the exact same bytes. `device_id` is length-prefixed so a
/// device id can't collide with a public-key prefix.
pub fn binding_leaf(user_id: &[u8], device_id: &str, public_key: &[u8]) -> Vec<u8> {
    let did = device_id.as_bytes();
    let mut out = Vec::with_capacity(16 + 4 + did.len() + public_key.len());
    out.extend_from_slice(user_id);
    out.extend_from_slice(&(did.len() as u32).to_be_bytes());
    out.extend_from_slice(did);
    out.extend_from_slice(public_key);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_of(n: usize) -> MerkleLog {
        let mut log = MerkleLog::new();
        for i in 0..n {
            log.append(format!("binding-{i}").as_bytes());
        }
        log
    }

    #[test]
    fn empty_and_single_roots() {
        assert_eq!(MerkleLog::new().root(), empty_root());
        let mut one = MerkleLog::new();
        one.append(b"x");
        assert_eq!(one.root(), hash_leaf(b"x"));
    }

    #[test]
    fn root_matches_hand_computed_two_and_three() {
        let mut two = MerkleLog::new();
        two.append(b"a");
        two.append(b"b");
        assert_eq!(two.root(), hash_node(&hash_leaf(b"a"), &hash_leaf(b"b")));

        // n=3 splits 2|1: H( H(a,b) , leaf(c) ).
        let mut three = two.clone();
        three.append(b"c");
        let expect = hash_node(
            &hash_node(&hash_leaf(b"a"), &hash_leaf(b"b")),
            &hash_leaf(b"c"),
        );
        assert_eq!(three.root(), expect);
    }

    #[test]
    fn every_inclusion_proof_verifies() {
        for n in 1..=64 {
            let log = log_of(n);
            let root = log.root();
            for i in 0..n {
                let proof = log.inclusion_proof(i).expect("in range");
                let leaf = hash_leaf(format!("binding-{i}").as_bytes());
                assert!(
                    verify_inclusion(&leaf, i, n, &root, &proof),
                    "inclusion n={n} i={i} must verify"
                );
            }
            assert!(log.inclusion_proof(n).is_none(), "out-of-range rejected");
        }
    }

    #[test]
    fn tampered_inclusion_fails() {
        let log = log_of(11);
        let root = log.root();
        let leaf = hash_leaf(b"binding-3");
        let mut proof = log.inclusion_proof(3).unwrap();
        assert!(verify_inclusion(&leaf, 3, 11, &root, &proof));

        // Wrong index, wrong leaf, flipped proof node, truncated proof, extra node.
        assert!(!verify_inclusion(&leaf, 4, 11, &root, &proof));
        assert!(!verify_inclusion(&hash_leaf(b"evil"), 3, 11, &root, &proof));
        assert!(!verify_inclusion(
            &leaf,
            3,
            11,
            &root,
            &proof[..proof.len() - 1]
        ));
        let mut longer = proof.clone();
        longer.push([0u8; 32]);
        assert!(!verify_inclusion(&leaf, 3, 11, &root, &longer));
        proof[0][0] ^= 0xff;
        assert!(!verify_inclusion(&leaf, 3, 11, &root, &proof));
    }

    #[test]
    fn every_consistency_proof_verifies() {
        for n in 1..=48 {
            let new_log = log_of(n);
            let new_root = new_log.root();
            for m in 1..=n {
                // The old tree is the prefix of the first m leaves.
                let old_log = log_of(m);
                let old_root = old_log.root();
                let proof = new_log.consistency_proof(m).expect("valid range");
                assert!(
                    verify_consistency(m, n, &old_root, &new_root, &proof),
                    "consistency m={m} n={n} must verify"
                );
            }
        }
    }

    #[test]
    fn consistency_rejects_a_rewritten_history() {
        // Server shows an old head of 5, then a new head of 8 that is NOT an
        // extension (leaf 2 was swapped) — the consistency proof must fail.
        let old = log_of(5);
        let old_root = old.root();

        let mut tampered = log_of(8);
        tampered.leaves[2] = hash_leaf(b"substituted-key"); // rewrite history
        let proof = tampered.consistency_proof(5).unwrap();
        assert!(
            !verify_consistency(5, 8, &old_root, &tampered.root(), &proof),
            "a rewritten prefix must be detected"
        );

        // A legitimate extension of the same prefix verifies.
        let honest = log_of(8);
        let honest_proof = honest.consistency_proof(5).unwrap();
        assert!(verify_consistency(
            5,
            8,
            &old_root,
            &honest.root(),
            &honest_proof
        ));
    }

    #[test]
    fn consistency_edges() {
        let log = log_of(7);
        let root = log.root();
        // Equal sizes → empty proof, roots equal.
        assert!(verify_consistency(7, 7, &root, &root, &[]));
        // old_size 0 or beyond current → no proof.
        assert!(log.consistency_proof(0).is_none());
        assert!(log.consistency_proof(8).is_none());
    }

    #[test]
    fn binding_leaf_is_unambiguous() {
        // ("ab","c") vs ("a","bc") must not collide thanks to the length prefix.
        let a = binding_leaf(b"u", "ab", b"c");
        let b = binding_leaf(b"u", "a", b"bc");
        assert_ne!(a, b);
    }
}
