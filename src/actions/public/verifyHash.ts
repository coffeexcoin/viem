import type { Address } from 'abitype'

import { encodeFunctionData, hexToBool } from '~viem/utils/index.js'
import type { Client } from '../../clients/createClient.js'
import type { Transport } from '../../clients/transports/createTransport.js'
import { universalSignatureValidatorAbi } from '../../constants/abis.js'
import { universalSignatureValidatorByteCode } from '../../constants/contracts.js'
import { CallExecutionError } from '../../errors/contract.js'
import type { InvalidHexBooleanError } from '../../errors/encoding.js'
import type { ErrorType } from '../../errors/utils.js'
import type { Chain } from '../../types/chain.js'
import type { ByteArray, Hex, Signature } from '../../types/misc.js'
import type { OneOf } from '../../types/utils.js'
import {
  type EncodeDeployDataErrorType,
  encodeDeployData,
} from '../../utils/abi/encodeDeployData.js'
import { getAddress } from '../../utils/address/getAddress.js'
import { isAddressEqual } from '../../utils/address/isAddressEqual.js'
import { type IsHexErrorType, isHex } from '../../utils/data/isHex.js'
import { type ToHexErrorType, bytesToHex } from '../../utils/encoding/toHex.js'
import { getAction } from '../../utils/getAction.js'
import { isErc6492Signature } from '../../utils/signature/isErc6492Signature.js'
import { recoverAddress } from '../../utils/signature/recoverAddress.js'
import { serializeErc6492Signature } from '../../utils/signature/serializeErc6492Signature.js'
import { serializeSignature } from '../../utils/signature/serializeSignature.js'
import { type CallErrorType, type CallParameters, call } from './call.js'

export type VerifyHashParameters = Pick<
  CallParameters,
  'blockNumber' | 'blockTag'
> & {
  /** The address that signed the original message. */
  address: Address
  /** The hash to be verified. */
  hash: Hex
  /** The signature that was generated by signing the message with the address's private key. */
  signature: Hex | ByteArray | Signature
} & OneOf<{ factory: Address; factoryData: Hex } | {}>

export type VerifyHashReturnType = boolean

export type VerifyHashErrorType =
  | CallErrorType
  | IsHexErrorType
  | ToHexErrorType
  | InvalidHexBooleanError
  | EncodeDeployDataErrorType
  | ErrorType

/**
 * Verifies a message hash onchain using ERC-6492.
 *
 * @param client - Client to use.
 * @param parameters - {@link VerifyHashParameters}
 * @returns Whether or not the signature is valid. {@link VerifyHashReturnType}
 */
export async function verifyHash<chain extends Chain | undefined>(
  client: Client<Transport, chain>,
  parameters: VerifyHashParameters,
): Promise<VerifyHashReturnType> {
  const { address, factory, factoryData, hash, signature, ...rest } = parameters

  const signatureHex = (() => {
    if (isHex(signature)) return signature
    if (typeof signature === 'object' && 'r' in signature && 's' in signature)
      return serializeSignature(signature)
    return bytesToHex(signature)
  })()

  const wrappedSignature = await (async () => {
    // If no `factory` or `factoryData` is provided, it is assumed that the
    // address is not a Smart Account, or the Smart Account is already deployed.
    if (!factory && !factoryData) return signatureHex

    // If the signature is already wrapped, return the signature.
    if (isErc6492Signature(signatureHex)) return signatureHex

    // If the Smart Account is not deployed, wrap the signature with a 6492 wrapper
    // to perform counterfactual validation.
    return serializeErc6492Signature({
      address: factory!,
      data: factoryData!,
      signature: signatureHex,
    })
  })()

  try {
    const callParameters: CallParameters = client.chain?.contracts
      ?.universalSignatureVerifier
      ? ({
          to: client.chain.contracts.universalSignatureVerifier.address,
          data: encodeFunctionData({
            abi: universalSignatureValidatorAbi,
            functionName: 'isValidUniversalSig',
            args: [address, hash, wrappedSignature],
          }),
          ...rest,
        } as unknown as CallParameters)
      : ({
          data: encodeDeployData({
            abi: universalSignatureValidatorAbi,
            args: [address, hash, wrappedSignature],
            bytecode: universalSignatureValidatorByteCode,
          }),
          ...rest,
        } as unknown as CallParameters)

    const { data } = await getAction(client, call, 'call')(callParameters)

    return hexToBool(data ?? '0x0')
  } catch (error) {
    // Fallback attempt to verify the signature via ECDSA recovery.
    try {
      const verified = isAddressEqual(
        getAddress(address),
        await recoverAddress({ hash, signature }),
      )
      if (verified) return true
    } catch {}

    if (error instanceof CallExecutionError) {
      // if the execution fails, the signature was not valid and an internal method inside of the validator reverted
      // this can happen for many reasons, for example if signer can not be recovered from the signature
      // or if the signature has no valid format
      return false
    }

    throw error
  }
}
