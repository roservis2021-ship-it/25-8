#include "PluginProcessor.h"
#include "PluginEditor.h"

EchoDriftAudioProcessor::EchoDriftAudioProcessor()
    : AudioProcessor (BusesProperties()
                           .withInput  ("Input",  juce::AudioChannelSet::stereo(), true)
                           .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "PARAMETERS", createParameterLayout())
{
}

EchoDriftAudioProcessor::~EchoDriftAudioProcessor() = default;

juce::AudioProcessorValueTreeState::ParameterLayout EchoDriftAudioProcessor::createParameterLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;

    params.push_back (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { delayTimeParamId, 1 }, "Delay Time",
        juce::NormalisableRange<float> (1.0f, 2000.0f, 0.1f, 0.35f), 350.0f,
        juce::AudioParameterFloatAttributes().withLabel ("ms")));

    params.push_back (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { feedbackParamId, 1 }, "Feedback",
        juce::NormalisableRange<float> (0.0f, 0.95f, 0.001f), 0.35f,
        juce::AudioParameterFloatAttributes().withLabel ("%").withStringFromValueFunction (
            [] (float v, int) { return juce::String (juce::roundToInt (v * 100.0f)); })));

    params.push_back (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { mixParamId, 1 }, "Mix",
        juce::NormalisableRange<float> (0.0f, 1.0f, 0.001f), 0.3f,
        juce::AudioParameterFloatAttributes().withLabel ("%").withStringFromValueFunction (
            [] (float v, int) { return juce::String (juce::roundToInt (v * 100.0f)); })));

    params.push_back (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { toneParamId, 1 }, "Tone",
        juce::NormalisableRange<float> (200.0f, 18000.0f, 1.0f, 0.3f), 6000.0f,
        juce::AudioParameterFloatAttributes().withLabel ("Hz")));

    return { params.begin(), params.end() };
}

void EchoDriftAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    currentSampleRate = sampleRate;

    const auto maxDelaySamples = (int) std::ceil (maxDelaySeconds * sampleRate);

    juce::dsp::ProcessSpec spec;
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = (juce::uint32) samplesPerBlock;
    spec.numChannels = 1;

    delayLineLeft.reset();
    delayLineRight.reset();
    delayLineLeft.setMaximumDelayInSamples (maxDelaySamples);
    delayLineRight.setMaximumDelayInSamples (maxDelaySamples);
    delayLineLeft.prepare (spec);
    delayLineRight.prepare (spec);

    toneFilterLeft.reset();
    toneFilterRight.reset();
    toneFilterLeft.prepare (spec);
    toneFilterRight.prepare (spec);

    smoothedDelayTime.reset (sampleRate, 0.02);
    smoothedFeedback.reset (sampleRate, 0.02);
    smoothedMix.reset (sampleRate, 0.02);

    smoothedDelayTime.setCurrentAndTargetValue (*apvts.getRawParameterValue (delayTimeParamId));
    smoothedFeedback.setCurrentAndTargetValue (*apvts.getRawParameterValue (feedbackParamId));
    smoothedMix.setCurrentAndTargetValue (*apvts.getRawParameterValue (mixParamId));
}

void EchoDriftAudioProcessor::releaseResources()
{
}

bool EchoDriftAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& mainIn  = layouts.getMainInputChannelSet();
    const auto& mainOut = layouts.getMainOutputChannelSet();

    if (mainOut != juce::AudioChannelSet::mono() && mainOut != juce::AudioChannelSet::stereo())
        return false;

    return mainIn == mainOut;
}

void EchoDriftAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const auto numChannels = buffer.getNumChannels();
    const auto numSamples  = buffer.getNumSamples();

    for (auto ch = getTotalNumInputChannels(); ch < getTotalNumOutputChannels(); ++ch)
        buffer.clear (ch, 0, numSamples);

    smoothedDelayTime.setTargetValue (*apvts.getRawParameterValue (delayTimeParamId));
    smoothedFeedback.setTargetValue (*apvts.getRawParameterValue (feedbackParamId));
    smoothedMix.setTargetValue (*apvts.getRawParameterValue (mixParamId));

    const auto toneHz = apvts.getRawParameterValue (toneParamId)->load();
    auto coeffs = juce::dsp::IIR::Coefficients<float>::makeLowPass (currentSampleRate, toneHz);
    toneFilterLeft.coefficients = coeffs;
    toneFilterRight.coefficients = coeffs;

    auto* left  = buffer.getWritePointer (0);
    auto* right = numChannels > 1 ? buffer.getWritePointer (1) : nullptr;

    for (int i = 0; i < numSamples; ++i)
    {
        const auto delayMs = smoothedDelayTime.getNextValue();
        const auto feedback = smoothedFeedback.getNextValue();
        const auto mix = smoothedMix.getNextValue();
        const auto delaySamples = (float) (delayMs * 0.001 * currentSampleRate);

        delayLineLeft.setDelay (delaySamples);
        const auto dryL = left[i];
        const auto delayedL = delayLineLeft.popSample (0);
        const auto filteredL = toneFilterLeft.processSample (delayedL);
        delayLineLeft.pushSample (0, dryL + filteredL * feedback);
        left[i] = dryL * (1.0f - mix) + delayedL * mix;

        if (right != nullptr)
        {
            delayLineRight.setDelay (delaySamples);
            const auto dryR = right[i];
            const auto delayedR = delayLineRight.popSample (0);
            const auto filteredR = toneFilterRight.processSample (delayedR);
            delayLineRight.pushSample (0, dryR + filteredR * feedback);
            right[i] = dryR * (1.0f - mix) + delayedR * mix;
        }
    }
}

juce::AudioProcessorEditor* EchoDriftAudioProcessor::createEditor()
{
    return new EchoDriftAudioProcessorEditor (*this);
}

bool EchoDriftAudioProcessor::hasEditor() const { return true; }

const juce::String EchoDriftAudioProcessor::getName() const { return JucePlugin_Name; }

bool EchoDriftAudioProcessor::acceptsMidi() const { return false; }
bool EchoDriftAudioProcessor::producesMidi() const { return false; }
bool EchoDriftAudioProcessor::isMidiEffect() const { return false; }
double EchoDriftAudioProcessor::getTailLengthSeconds() const { return maxDelaySeconds; }

int EchoDriftAudioProcessor::getNumPrograms() { return 1; }
int EchoDriftAudioProcessor::getCurrentProgram() { return 0; }
void EchoDriftAudioProcessor::setCurrentProgram (int) {}
const juce::String EchoDriftAudioProcessor::getProgramName (int) { return {}; }
void EchoDriftAudioProcessor::changeProgramName (int, const juce::String&) {}

void EchoDriftAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    if (auto state = apvts.copyState(); state.isValid())
    {
        if (auto xml = state.createXml())
            copyXmlToBinary (*xml, destData);
    }
}

void EchoDriftAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    if (auto xml = getXmlFromBinary (data, sizeInBytes))
        if (xml->hasTagName (apvts.state.getType()))
            apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new EchoDriftAudioProcessor();
}
