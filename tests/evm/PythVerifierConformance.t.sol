// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

// Dependencies remain in the operator-supplied upstream checkout, not this repo.
import {Test} from "forge-std/Test.sol";
import {PythLazer} from "pyth-external/PythLazer.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Isolated cryptographic fixtures, never production prices or credentials.
contract PythVerifierConformance is Test {
    uint256 private constant TEST_SIGNER_KEY = 0xA11CE;
    uint256 private constant UNKNOWN_TEST_KEY = 0xB0B;
    uint256 private constant TEST_TIME = 1_788_732_000;
    PythLazer private verifier;
    bytes private payload;

    function setUp() public {
        vm.warp(TEST_TIME);
        vm.deal(address(this), 1 ether);
        PythLazer implementation = new PythLazer();
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation), address(this), abi.encodeWithSelector(PythLazer.initialize.selector, address(this))
        );
        verifier = PythLazer(address(proxy));
        verifier.updateTrustedSigner(vm.addr(TEST_SIGNER_KEY), TEST_TIME + 60);
        // Header + one feed, five fields. Feed ID 42 is a local test identifier.
        payload = bytes.concat(
            abi.encodePacked(
                uint32(2479346549), uint64(TEST_TIME * 1_000_000), uint8(1), uint8(1), uint32(42), uint8(5)
            ),
            abi.encodePacked(uint8(0), int64(123456789), uint8(3), uint16(3), uint8(4), int16(-6)),
            abi.encodePacked(uint8(5), uint64(125), uint8(12), uint8(1), uint64(TEST_TIME * 1_000_000 - 1000))
        );
    }

    function signedUpdate(uint256 testKey) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(testKey, keccak256(payload));
        return abi.encodePacked(uint32(706910618), r, s, uint8(v - 27), uint16(payload.length), payload);
    }

    function test_acceptsSignedPayloadAndReturnsExactSigner() public {
        assertEq(verifier.version(), "0.1.1");
        assertEq(verifier.verification_fee(), 1);
        (bytes memory returned, address signer) = verifier.verifyUpdate{value: 1}(signedUpdate(TEST_SIGNER_KEY));
        assertEq(returned, payload);
        assertEq(signer, vm.addr(TEST_SIGNER_KEY));
    }

    function test_rejectsTamperedSignature() public {
        bytes memory update = signedUpdate(TEST_SIGNER_KEY);
        update[4] = bytes1(uint8(update[4]) ^ 1);
        vm.expectRevert();
        verifier.verifyUpdate{value: 1}(update);
    }

    function test_rejectsTamperedPayload() public {
        bytes memory update = signedUpdate(TEST_SIGNER_KEY);
        update[update.length - 1] = bytes1(uint8(update[update.length - 1]) ^ 1);
        vm.expectRevert();
        verifier.verifyUpdate{value: 1}(update);
    }

    function test_rejectsUnknownSigner() public {
        bytes memory update = signedUpdate(UNKNOWN_TEST_KEY);
        vm.expectRevert("invalid signer");
        verifier.verifyUpdate{value: 1}(update);
    }

    function test_rejectsExpiredSignerAtExactExpiry() public {
        bytes memory update = signedUpdate(TEST_SIGNER_KEY);
        vm.warp(TEST_TIME + 60);
        vm.expectRevert("invalid signer");
        verifier.verifyUpdate{value: 1}(update);
    }

    function test_rejectsInsufficientFee() public {
        bytes memory update = signedUpdate(TEST_SIGNER_KEY);
        vm.expectRevert("Insufficient fee provided");
        verifier.verifyUpdate(update);
    }
}
